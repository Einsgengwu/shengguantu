/* ============================================================
   《大宋升官图》— 大富翁式北宋官制棋盘游戏
   独立小游戏，内嵌于《九州升官记》。纯 vanilla JS，无构建。
   设计依据：GameDesign_doc/大宋升官图_GDD_v1.md（v1.0 + v1.1 改版）

   v1.1 改版要点：
   - 棋盘由单环 23×23 改为「双环回字盘」15×11，格子更大更清晰
   - 每个事件格直接标注效果徽标（进/退/升/降/弹/禁/困/择/奇/谋反）
   - 仕途榜显示品阶 + 当前官名全称
   - 节奏整体放慢（SGT_SPEED 常量统一调度）
   - 新增 2v2 组队对抗（队友托管时由真人手动决定是否使用道具）
   - 新增道具「禁足令」：令目标一回合不能掷骰
   - 新增事件格「谋反」：回到起点，但赠弹劾令 ×2
   ============================================================ */
'use strict';

/* ------------------------------------------------------------
   节奏调度（统一管理所有延时，便于放慢/调试）
   ------------------------------------------------------------ */
const SGT_SPEED = {
  aiThink:    1300,  // AI 回合开始到掷骰的思考停顿
  aiItemHold:  900,  // AI 使用道具后到掷骰的停顿
  diceSpin:     95,  // 骰面跳动间隔
  diceSpins:    12,  // 骰面跳动次数
  diceSettle:   750, // 骰子定格后停顿
  moveStep:     230, // 棋子每格移动间隔
  stuckHold:   1400, // 困住跳过回合的停顿
  humanEvent:  1700, // 真人事件结算后进入下一回合的停顿
  aiEvent:     3800  // 托管事件结算后进入下一回合的停顿（v1.2 再放慢，缓解 2v2 连续 AI 看不完事件）
};

/* ------------------------------------------------------------
   商店与钱财（v1.2）：升官得财、降官扣财，钱财可购道具
   ------------------------------------------------------------ */
const SGT_SHOP = {
  tokPrice: 600,  // 弹劾令售价（缗）
  banPrice: 450,  // 禁足令售价（缗）
  buyCap:   3,    // 单局购买总上限（两种合计）
  holdCap:  3     // 同时持有道具上限（含事件赠予）
};
// 升/降「第 r 阶」对应的财货增减：品阶越高单级越值钱
function sgtRankReward(r) { return r * 10; }
// 依当前品阶与上次记录对账钱财（升加、降减，下限 0）。幂等。
function sgtSyncCoins(p) {
  const nr = sgtOfficeRankAt(p.pos);
  if (nr > p.rank) { for (let r = p.rank + 1; r <= nr; r++) p.coins += sgtRankReward(r); }
  else if (nr < p.rank) { for (let r = p.rank; r > nr; r--) p.coins -= sgtRankReward(r); }
  if (p.coins < 0) p.coins = 0;
  p.rank = nr;
}

/* ------------------------------------------------------------
   一、品阶体系（22 阶，0=从九品 … 21=正一品）
   章服：0–6 绿、7–12 绯、13–21 紫
   ------------------------------------------------------------ */
const SGT_RANKS = [
  '从九品·太常寺奉礼郎', '正九品下·秘书省正字', '正九品·秘书省校书郎',
  '从八品·诸寺监主簿',   '正八品·监察御史',     '从七品下·殿中侍御史',
  '从七品上·国子监博士', '从六品下·侍御史',     '从六品上·著作佐郎',
  '从五品下·太子洗马',   '从五品上·尚书左司郎中', '正五品下·太子中允',
  '正五品上·给事中',     '从四品·国子祭酒',     '正四品下·吏部侍郎',
  '正四品上·尚书左丞',   '从三品·秘书监',       '正三品·吏部尚书',
  '从二品·尚书左仆射',   '正二品·太子少师',     '从一品·太子太师',
  '正一品·太师'
];
function sgtRobe(rank) { return rank <= 6 ? 'green' : rank <= 12 ? 'red' : 'purple'; }
function sgtRobeName(rank) { return rank <= 6 ? '绿袍' : rank <= 12 ? '绯袍' : '紫袍'; }
function sgtRankTier(rank) { return SGT_RANKS[rank].split('·')[0]; } // 品阶
function sgtRankOffice(rank) { return SGT_RANKS[rank].split('·')[1] || ''; } // 官名

/* ------------------------------------------------------------
   二、棋盘 88 格（依 GDD 附录 A 完整映射）
   每格：{ kind:'office'|'event'|'fortune'|'start'|'goal', name, rank?, text, fx:[acts] }
   act 类型：
     none / adv N / ret N / pro N / dem N / retOff / nextOff
     tok N / loseTok / ban N / stuck N / dingyou / rebel
     allDem N / destiny / guiren / yubi / gamble
     choice（独立字段 opts）
   ------------------------------------------------------------ */
// 官职格：board index → rank（v1.1：三环 120 格，22 阶各 1 格）
const SGT_OFFICE = {
  0: 0, 5: 1, 10: 2, 16: 3, 22: 4, 28: 5, 34: 6,        // 绿袍
  40: 7, 46: 8, 52: 9, 58: 10, 63: 11, 68: 12,          // 绯袍
  74: 13, 80: 14, 86: 15, 92: 16, 98: 17, 104: 18,      // 紫袍
  109: 19, 114: 20, 119: 21
};
const SGT_OFFICE_IDX = Object.keys(SGT_OFFICE).map(Number).sort((a, b) => a - b);

// 事件/奇遇格定义（未列出的官职格由 SGT_OFFICE 生成）
// v1.1：三环 120 格 → 98 事件/奇遇格。绿袍温和、绯袍党争渐起、紫袍凶险。
const SGT_EVENTS = {
  /* ── 绿袍区（南/外环前段，官职格 0/5/10/16/22/28/34）── */
  1:  { text: '初入仕途，战战兢兢，唯恐失仪。', fx: [] },
  2:  { text: '抄写公文，字迹工整，为长官所赏。', fx: [{ t: 'adv', n: 1 }] },
  3:  { text: '户曹算错一笔账，连坐受责。', fx: [{ t: 'ret', n: 1 }] },
  4:  { text: '晨谒省门，谨守班次，无功无过。', fx: [] },
  6:  { text: '馆阁读书，博览群籍，学问大进。', fx: [{ t: 'pro', n: 1 }] },
  7:  { text: '兢兢业业，考课连年优等。', fx: [{ t: 'adv', n: 2 }] },
  8:  { text: '校雠典籍有误，被罚重校三日。', fx: [{ t: 'ret', n: 1 }] },
  9:  { text: '风平浪静，案牍无事。', fx: [] },
  11: { text: '写错公文格式，被驳回重拟。', fx: [{ t: 'retOff' }] },
  12: { text: '随长官巡查诸县，表现干练。', fx: [{ t: 'adv', n: 2 }] },
  13: { text: '寺监账目不清，受牵连查问。', fx: [{ t: 'ret', n: 2 }] },
  14: { text: '路遇同年，把酒言欢，互道契阔。', fx: [] },
  15: { kind: 'fortune', name: '御笔亲批', text: '一道御笔忽下，命运自择——前进三阶，或退后三阶。', fx: [{ t: 'yubi' }] },
  17: { text: '初膺台谏之选，风闻奏事，权柄初染。', fx: [{ t: 'tok', n: 1 }] },
  18: { text: '弹劾不实，反坐其罪。', fx: [{ t: 'dem', n: 1 }] },
  19: { text: '下乡劝农，桑麻遍野，百姓爱戴。', fx: [{ t: 'adv', n: 1 }] },
  20: { text: '案牍劳形，循例守职，无功无过，原位驻留。', fx: [] },
  21: { text: '州府举荐贤良方正，名达于朝。', fx: [{ t: 'pro', n: 1 }, { t: 'adv', n: 1 }] },
  23: { text: '殿中纠仪，严正不阿，台纲肃然。', fx: [{ t: 'tok', n: 1 }] },
  24: { text: '为权贵所嫉恨，遭其党羽弹劾。', fx: [{ t: 'dem', n: 1 }] },
  25: { text: '掌州门管钥，可阻人于关下。', fx: [{ t: 'ban', n: 1 }] },
  26: { text: '同僚排挤，孤立无援。', fx: [{ t: 'ret', n: 1 }] },
  27: { text: '值夜禁中，拾遗金不昧，帝闻而嘉之。', fx: [{ t: 'pro', n: 1 }] },
  29: {
    text: '欲上书直陈教学之弊，然恐忤上意。', fx: [{ t: 'choice' }],
    opts: [
      { label: '直言其弊', hint: '获弹劾令牌×1，然后退1格', fx: [{ t: 'tok', n: 1 }, { t: 'ret', n: 1 }] },
      { label: '婉转其辞', hint: '无事', fx: [] }
    ]
  },
  30: { text: '门生科举高中，师以为荣。', fx: [{ t: 'pro', n: 1 }] },
  31: { text: '博士论经，被指穿凿附会。', fx: [{ t: 'ret', n: 1 }] },
  32: { text: '奉使劳军，往返无失。', fx: [{ t: 'adv', n: 1 }] },
  33: { text: '弹劾巨贪，一战成名，朝野侧目。', fx: [{ t: 'pro', n: 1 }, { t: 'tok', n: 1 }] },

  /* ── 绯袍区（东/内环前段，官职格 40/46/52/58/63/68）── */
  35: { text: '太学授课，发明经义，士子景从。', fx: [{ t: 'adv', n: 2 }] },
  36: { text: '撰文偶触庙讳，交部察议。', fx: [{ t: 'dem', n: 1 }] },
  37: { text: '编纂《日历》，一字之褒，荣于华衮。', fx: [] },
  38: { text: '上《时务策》十篇，切中时弊。', fx: [{ t: 'pro', n: 1 }] },
  39: { text: '修史疏漏，被同僚纠出。', fx: [{ t: 'ret', n: 2 }] },
  41: { text: '秘阁校书，于乱帙中发现孤本。', fx: [{ t: 'adv', n: 2 }] },
  42: { text: '丁忧守制，归乡庐墓。守孝名节，朝廷起复。', fx: [{ t: 'dingyou' }] },
  43: { text: '被借调修《会要》，预闻典章。', fx: [{ t: 'pro', n: 1 }] },
  44: { kind: 'fortune', name: '紫微星动', text: '紫微垣中，将星忽明忽暗——掷一枚天命之骰，吉凶未卜。', fx: [{ t: 'destiny' }] },
  45: { text: '东宫讲读，太子敬服，待以师礼。', fx: [{ t: 'pro', n: 1 }] },
  47: { text: '太子失德，师傅连坐受责。', fx: [{ t: 'dem', n: 1 }] },
  48: { text: '省中主事，案牍井井，权柄渐重。', fx: [{ t: 'tok', n: 1 }] },
  49: { text: '六部文书例行勾稽，安守本任，原地不动。', fx: [] },
  50: { text: '新政推行，建言被纳，圣眷渐隆。', fx: [{ t: 'pro', n: 1 }, { t: 'adv', n: 1 }] },
  51: { text: '巡按一路，举劾贪墨，风裁凛然。', fx: [{ t: 'adv', n: 2 }] },
  53: {
    text: '权相私宴相邀，杯酒之间，意在拉拢。', fx: [{ t: 'choice' }],
    opts: [
      { label: '攀附权门', hint: '升一品阶，然失弹劾令牌×1', fx: [{ t: 'pro', n: 1 }, { t: 'loseTok' }] },
      { label: '婉拒其请', hint: '无事，获弹劾令牌×1', fx: [{ t: 'tok', n: 1 }] }
    ]
  },
  54: {
    text: '欲上书言时政十弊，激切恐贾祸，温和恐无益。', fx: [{ t: 'choice' }],
    opts: [
      { label: '激切陈词', hint: '升一品阶，然困1回合', fx: [{ t: 'pro', n: 1 }, { t: 'stuck', n: 1 }] },
      { label: '温言敷奏', hint: '无事', fx: [] }
    ]
  },
  55: { text: '封驳不当，被斥越权。', fx: [{ t: 'dem', n: 1 }] },
  56: { text: '封驳诏书，面折廷争，不避权要。', fx: [{ t: 'pro', n: 1 }, { t: 'tok', n: 1 }] },
  57: { text: '朝议新法，慷慨陈词，四座动容。', fx: [{ t: 'adv', n: 2 }] },
  59: { text: '旧党反扑，政敌交章构陷。', fx: [{ t: 'ret', n: 2 }, { t: 'dem', n: 1 }] },
  60: { text: '主持省试，得人甚盛，门下多俊彦。', fx: [{ t: 'pro', n: 1 }] },
  61: { text: '科举舞弊案起，被无端牵连。', fx: [{ t: 'dem', n: 1 }, { t: 'stuck', n: 1 }] },
  62: { text: '奏请扩太学，养士育才，获准。', fx: [{ t: 'adv', n: 2 }, { t: 'tok', n: 1 }] },
  64: { text: '太学刻石经，功在文教，名垂学宫。', fx: [{ t: 'pro', n: 1 }] },
  65: { text: '掌出入禁钥，可锁人于阙下。', fx: [{ t: 'ban', n: 1 }] },
  66: { text: '漕运愆期，劾下有司，引咎承责。', fx: [{ t: 'ret', n: 1 }] },
  67: { text: '调停两司之争，时论称平，安守原任。', fx: [] },

  /* ── 紫袍区（北/西/最内环，官职格 74/80/86/92/98/104/109/114/119）── */
  69: { text: '掌铨选，举贤不避仇，时论称公。', fx: [{ t: 'pro', n: 1 }] },
  70: { text: '铨选失当，遭御史弹劾。', fx: [{ t: 'dem', n: 1 }] },
  71: { text: '综理庶务，握堂帖之权，能羁縻同列。', fx: [{ t: 'tok', n: 1 }] },
  72: { text: '尚书省失火，文书被焚，引咎自责。', fx: [{ t: 'ret', n: 2 }] },
  73: { text: '参预密勿，与闻军国大政。', fx: [{ t: 'pro', n: 1 }] },
  75: { text: '两府争议，居中调停有功。', fx: [{ t: 'adv', n: 2 }] },
  76: { kind: 'rebel', name: '谋反', text: '权臣密谋拥立，事泄败露！褫夺官身、贬为白丁、押回原籍——然旧部暗通款曲，遗你弹劾之柄。', fx: [{ t: 'rebel' }] },
  77: { text: '编修《国史》告竣，藏之秘阁。', fx: [{ t: 'pro', n: 1 }, { t: 'adv', n: 1 }] },
  78: {
    text: '党争白热，新旧两党皆来招揽，左右为难。', fx: [{ t: 'choice' }],
    opts: [
      { label: '投身新党', hint: '进退各半——成则前进2格，败则后退2格', fx: [{ t: 'gamble', win: [{ t: 'adv', n: 2 }], lose: [{ t: 'ret', n: 2 }] }] },
      { label: '超然中立', hint: '无事', fx: [] }
    ]
  },
  79: { text: '三朝耆旧，恩宠不衰，赐坐讲筵。', fx: [{ t: 'adv', n: 1 }] },
  81: { text: '掌百官铨衡，位高权重，门庭若市。', fx: [{ t: 'pro', n: 1 }, { t: 'tok', n: 1 }] },
  82: { text: '一朝天子一朝臣——新君即位，旧臣俱受裁抑。', fx: [{ t: 'allDem', n: 1 }] },
  83: { text: '新君励精图治，选贤与能，特加擢用。', fx: [{ t: 'adv', n: 2 }] },
  84: { text: '入主政事堂，秉钧当轴，天下仰望。', fx: [{ t: 'pro', n: 1 }] },
  85: { text: '权倾朝野，谏官侧目，赐你言事之柄。', fx: [{ t: 'tok', n: 1 }] },
  87: { text: '边衅骤起，荐你筹边，措置咸宜。', fx: [{ t: 'adv', n: 2 }] },
  88: { text: '朋党之祸，株连相及，受谪外迁。', fx: [{ t: 'dem', n: 1 }, { t: 'ret', n: 1 }] },
  89: { text: '调和鼎鼐，燮理阴阳，朝纲为之一肃。', fx: [{ t: 'pro', n: 1 }] },
  90: { kind: 'fortune', name: '贵人相助', text: '朝中贵人念旧，愿提携一人——可择一玩家，使其升一品阶。', fx: [{ t: 'guiren' }] },
  91: { text: '言官交章，劾你专权擅政。', fx: [{ t: 'dem', n: 1 }] },
  93: { text: '议立储贰，谋虑深远，圣心嘉纳。', fx: [{ t: 'pro', n: 1 }] },
  94: { text: '灾异示警，宰执循例自请补外。', fx: [{ t: 'ret', n: 2 }] },
  95: { text: '总领台谏，纠弹百僚，威权在握。', fx: [{ t: 'ban', n: 1 }] },
  96: { text: '边帅失律丧师，荐主连坐受责。', fx: [{ t: 'dem', n: 1 }] },
  97: { text: '燮和天下，海内乂安，颂声四起。', fx: [{ t: 'adv', n: 2 }] },
  99: { text: '进位三公，恩荣冠世，剑履殊礼。', fx: [{ t: 'pro', n: 1 }] },
  100: {
    text: '先帝顾命之托忽降——受之则身系社稷，辞之则明哲全身。', fx: [{ t: 'choice' }],
    opts: [
      { label: '受命辅政', hint: '升一品阶，然困1回合', fx: [{ t: 'pro', n: 1 }, { t: 'stuck', n: 1 }] },
      { label: '力辞不就', hint: '无事，获弹劾令牌×1', fx: [{ t: 'tok', n: 1 }] }
    ]
  },
  101: { text: '党人碑立，名列其间，落职奉祠。', fx: [{ t: 'dem', n: 1 }, { t: 'stuck', n: 1 }] },
  102: { text: '上章告老，天子优诏慰留，仍居原位。', fx: [] },
  103: {
    text: '新旧之争再起，调和则犯众怒，独断则结深仇。', fx: [{ t: 'choice' }],
    opts: [
      { label: '锐意调和', hint: '进退各半——成则升1品阶，败则降1品阶', fx: [{ t: 'gamble', win: [{ t: 'pro', n: 1 }], lose: [{ t: 'dem', n: 1 }] }] },
      { label: '明哲保身', hint: '无事', fx: [] }
    ]
  },
  105: { text: '册拜太傅，位极人臣之渐。', fx: [{ t: 'pro', n: 1 }] },
  106: { text: '飞语中伤，几陷大狱，幸而获释。', fx: [{ t: 'ret', n: 2 }] },
  107: { text: '新君亲政，尽罢前朝辅弼之臣。', fx: [{ t: 'allDem', n: 1 }] },
  108: { text: '元老硕德，赐剑履上殿，授言事之权。', fx: [{ t: 'tok', n: 1 }] },
  110: { text: '加九锡之议骤起，谤亦随之而至。', fx: [{ t: 'dem', n: 1 }] },
  111: { text: '三登台辅，勋德并隆，天下仰望。', fx: [{ t: 'adv', n: 2 }] },
  112: { kind: 'fortune', name: '御笔再批', text: '御笔再下，命运又择——前进三阶，或退后三阶。', fx: [{ t: 'yubi' }] },
  113: { text: '谗者构陷，几致倾覆，赖众正保全。', fx: [{ t: 'ret', n: 1 }] },
  115: { text: '拜太师之渐，群臣交章推毂。', fx: [{ t: 'pro', n: 1 }] },
  116: { text: '末路凶险，政敌作最后一搏。', fx: [{ t: 'ret', n: 2 }] },
  117: { text: '黄阁清风，众望所归，圣眷愈隆。', fx: [{ t: 'adv', n: 1 }] },
  118: { text: '一阶之遥，戒慎恐惧，如履薄冰。', fx: [] }
};

// 生成完整 120 格棋盘
const SGT_N = 120;
const SGT_GOAL = SGT_N - 1; // 119
function sgtBuildBoard() {
  const board = [];
  for (let i = 0; i < SGT_N; i++) {
    if (i in SGT_OFFICE) {
      const rank = SGT_OFFICE[i];
      board.push({
        i, kind: i === 0 ? 'start' : i === SGT_GOAL ? 'goal' : 'office',
        rank, name: SGT_RANKS[rank], robe: sgtRobe(rank),
        text: i === 0 ? '从九品·太常寺奉礼郎。仕途之始，青衫一袭。'
            : i === SGT_GOAL ? '正一品·太师。位极人臣，到此即胜！'
            : `履新${SGT_RANKS[rank]}，品阶锚定于此。`,
        fx: []
      });
    } else {
      const e = SGT_EVENTS[i] || { text: '此处暂无事。', fx: [] };
      board.push({
        i, kind: e.kind || 'event', name: e.name || '',
        text: e.text, fx: e.fx || [], opts: e.opts || null
      });
    }
  }
  return board;
}
const SGT_BOARD = sgtBuildBoard();

/* 事件格徽标：把首个 act 翻译为格面短标 {label, cls}
   v1.2：仅特殊格保留颜色——谋反(b-rebel)、获弹劾令(b-tok)、获禁足令(b-ban)；
   其余一律墨字 b-plain（奇遇格的「奇」由 buildBoardDom 单独以 b-fortune 着色）。 */
function sgtFxBadge(cell) {
  if (cell.kind === 'rebel') return { label: '谋反', cls: 'b-rebel' };
  const fx = cell.fx;
  if (!fx || !fx.length) return { label: '原', cls: 'b-plain' }; // 原位格
  const a = fx[0];
  switch (a.t) {
    case 'adv':     return { label: '进' + a.n, cls: 'b-plain' };
    case 'ret':     return { label: '退' + a.n, cls: 'b-plain' };
    case 'pro':     return { label: '升' + a.n, cls: 'b-plain' };
    case 'dem':     return { label: '降' + a.n, cls: 'b-plain' };
    case 'retOff':  return { label: '退职', cls: 'b-plain' };
    case 'nextOff': return { label: '进职', cls: 'b-plain' };
    case 'tok':     return { label: '弹+' + a.n, cls: 'b-tok' };   // 获道具：保留色
    case 'ban':     return { label: '禁+' + a.n, cls: 'b-ban' };   // 获道具：保留色
    case 'loseTok': return { label: '失弹', cls: 'b-plain' };
    case 'stuck':   return { label: '困' + a.n, cls: 'b-plain' };
    case 'dingyou': return { label: '丁忧', cls: 'b-plain' };
    case 'allDem':  return { label: '满降', cls: 'b-plain' };
    case 'rebel':   return { label: '谋反', cls: 'b-rebel' };
    case 'gamble':  return { label: '博', cls: 'b-plain' };
    case 'choice':  return { label: '择', cls: 'b-plain' };
    default:        return { label: '·', cls: 'b-plain' };
  }
}

/* 单个效果 act 的人类可读文案（用于格信息浮层） */
function sgtActText(a) {
  switch (a.t) {
    case 'adv':     return `前进 ${a.n} 格`;
    case 'ret':     return `后退 ${a.n} 格`;
    case 'pro':     return `升 ${a.n} 品阶`;
    case 'dem':     return `降 ${a.n} 品阶`;
    case 'retOff':  return '退回上一官职格';
    case 'nextOff': return '跳至下一官职格';
    case 'tok':     return `获弹劾令 ×${a.n}`;
    case 'ban':     return `获禁足令 ×${a.n}`;
    case 'loseTok': return '失弹劾令 ×1';
    case 'stuck':   return `困 ${a.n} 回合（停掷）`;
    case 'dingyou': return '困 1 回合，期满起复升 1 品阶';
    case 'allDem':  return `满朝同降 ${a.n} 品阶`;
    case 'rebel':   return '退回起点，获赠弹劾令 ×2';
    case 'gamble':  return '博弈：成则【' + (a.win || []).map(sgtActText).join('、') + '】，败则【' + (a.lose || []).map(sgtActText).join('、') + '】';
    case 'destiny': return '掷天命骰：吉则升品、凶则降品';
    case 'yubi':    return '自择：前进三阶 或 退后三阶';
    case 'guiren':  return '提携一名玩家升 1 品阶';
    case 'choice':  return '面临抉择';
    default:        return '';
  }
}
// 整格效果摘要
function sgtFxText(cell) {
  if (cell.opts) return '抉择 — ' + cell.opts.map(o => `「${o.label}」(${o.hint})`).join('；');
  if (!cell.fx || !cell.fx.length) return '原位驻留，安守本任（不进不退）';
  return cell.fx.map(sgtActText).filter(Boolean).join('，');
}

/* ------------------------------------------------------------
   三、棋盘几何 — 三环回字盘
   网格 15 列 × 11 行（row 0..10, col 0..14），顺时针向内盘旋。
   外环 48 格（#0–47）、中环 40 格（#48–87）、内环 32 格（#88–119），
   中央 9×5 留作牌匾。坐标为 [row, col]。
   ------------------------------------------------------------ */
const SGT_GRID_COLS = 15;
const SGT_GRID_ROWS = 11;
// 生成一圈矩形环坐标（左上角 r0,c0；宽 w 高 h），顺时针，从左上起步
function sgtRingCoords(r0, c0, w, h) {
  const c = [];
  for (let col = c0; col < c0 + w; col++) c.push([r0, col]);                 // 顶行 左→右
  for (let row = r0 + 1; row < r0 + h; row++) c.push([row, c0 + w - 1]);     // 右列 上→下
  for (let col = c0 + w - 2; col >= c0; col--) c.push([r0 + h - 1, col]);    // 底行 右→左
  for (let row = r0 + h - 2; row >= r0 + 1; row--) c.push([row, c0]);        // 左列 下→上
  return c;
}
function sgtCellCoords() {
  return [
    ...sgtRingCoords(0, 0, 15, 11), // 外环 #0–47   (48)
    ...sgtRingCoords(1, 1, 13, 9),  // 中环 #48–87  (40)
    ...sgtRingCoords(2, 2, 11, 7)   // 内环 #88–119 (32)
  ];
}
const SGT_COORDS = sgtCellCoords();

/* ------------------------------------------------------------
   四、官职轨工具 — pro/dem/jump 以「官职格」为步长
   ------------------------------------------------------------ */
function sgtOfficeRankAt(pos) {
  let r = 0;
  for (const idx of SGT_OFFICE_IDX) { if (idx <= pos) r = SGT_OFFICE[idx]; else break; }
  return r;
}
function sgtNextOffice(pos) {
  for (const idx of SGT_OFFICE_IDX) if (idx > pos) return idx;
  return SGT_GOAL;
}
function sgtPrevOffice(pos) {
  let prev = 0;
  for (const idx of SGT_OFFICE_IDX) { if (idx < pos) prev = idx; else break; }
  return prev;
}

/* ------------------------------------------------------------
   五、对局状态
   ------------------------------------------------------------ */
const SGT_COLORS = [
  { key: 'red',   name: '朱红', css: '#c04040', glyph: '仕' },
  { key: 'blue',  name: '靛蓝', css: '#3a5a9c', glyph: '官' },
  { key: 'green', name: '墨绿', css: '#2d5a3d', glyph: '升' },
  { key: 'ochre', name: '赭石', css: '#8b6b3d', glyph: '品' }
];
const SGT_TEAM_NAME = ['甲', '乙'];
// 2v2：同队同色，仅棋子文字不同（取象棋意象）。[team] → {css,name}；[team][seat] → 棋子字
const SGT_TEAM_COLORS = [
  { key: 'red',  name: '朱红', css: '#b5482e' },  // 甲队
  { key: 'blue', name: '靛蓝', css: '#3a5a9c' }   // 乙队
];
const SGT_TEAM_GLYPH = [['帥', '仕'], ['將', '士']];
function sgtTeamColor(team, seat) {
  return { key: SGT_TEAM_COLORS[team].key, name: SGT_TEAM_COLORS[team].name,
           css: SGT_TEAM_COLORS[team].css, glyph: SGT_TEAM_GLYPH[team][seat] };
}

let SGT = null; // 当前对局
function sgtNewGame(players, mode) {
  SGT = {
    players,            // [{id,name,color,isAI,humanItems,team,pos,tokens,bans,stuck,finished}]
    mode: mode || 'free', // free | team
    turn: 0,
    phase: 'roll',      // roll | resolving | choice | over
    log: [],
    winner: null,
    winnerTeam: null,
    proBudget: 0,       // 本回合连升预算（≤3）
    busy: false
  };
  return SGT;
}

/* 队友 / 对手判定 */
function sgtTeammates(p) { return SGT.players.filter(q => q !== p && q.team != null && q.team === p.team); }
function sgtOpponents(p) { return SGT.players.filter(q => q !== p && !q.finished && (p.team == null || q.team !== p.team)); }

/* ------------------------------------------------------------
   六、效果结算
   ------------------------------------------------------------ */
function sgtClampPos(p) { return Math.max(0, Math.min(SGT_GOAL, p)); }

// 应用一组 act 到 player；返回结算文字数组；可能产生连锁
function sgtApplyActs(p, acts, chainDepth) {
  chainDepth = chainDepth || 0;
  const msgs = [];
  for (const a of acts) {
    switch (a.t) {
      case 'adv': {
        p.pos = sgtClampPos(p.pos + a.n);
        msgs.push(`前进 ${a.n} 格`);
        sgtMaybeChain(p, msgs, chainDepth);
        break;
      }
      case 'ret': {
        p.pos = sgtClampPos(p.pos - a.n);
        msgs.push(`后退 ${a.n} 格`);
        sgtMaybeChain(p, msgs, chainDepth);
        break;
      }
      case 'pro': {
        let n = a.n;
        if (SGT.proBudget + n > 3) n = 3 - SGT.proBudget; // 连升上限3
        for (let k = 0; k < n; k++) p.pos = sgtNextOffice(p.pos);
        SGT.proBudget += n;
        msgs.push(n > 0 ? `升 ${n} 品阶` : '已达本回合连升之限');
        break;
      }
      case 'dem': {
        for (let k = 0; k < a.n; k++) p.pos = sgtPrevOffice(p.pos);
        msgs.push(`降 ${a.n} 品阶`);
        break;
      }
      case 'retOff': { p.pos = sgtPrevOffice(p.pos); msgs.push('退回上一官职格'); break; }
      case 'nextOff': { p.pos = sgtNextOffice(p.pos); msgs.push('跳转至下一官职格'); break; }
      case 'tok': {
        const add = Math.max(0, Math.min(a.n, SGT_SHOP.holdCap - (p.tokens + p.bans)));
        p.tokens += add;
        msgs.push(add > 0 ? `获弹劾令牌 ×${add}` : '道具已满（3 件），弹劾令未能入手');
        break;
      }
      case 'ban': {
        const add = Math.max(0, Math.min(a.n, SGT_SHOP.holdCap - (p.tokens + p.bans)));
        p.bans += add;
        msgs.push(add > 0 ? `获禁足令 ×${add}` : '道具已满（3 件），禁足令未能入手');
        break;
      }
      case 'loseTok': { if (p.tokens > 0) { p.tokens--; msgs.push('失弹劾令牌 ×1'); } break; }
      case 'stuck': { p.stuck += a.n; msgs.push(`困住 ${a.n} 回合`); break; }
      case 'rebel': {
        p.pos = 0;
        const add = Math.max(0, Math.min(2, SGT_SHOP.holdCap - (p.tokens + p.bans)));
        p.tokens += add;
        msgs.push(`谋反败露，贬归白丁——退回起点，然得弹劾令牌 ×${add}`);
        break;
      }
      case 'dingyou': {
        p.stuck += 1;
        let n = 1; if (SGT.proBudget + n > 3) n = 3 - SGT.proBudget;
        for (let k = 0; k < n; k++) p.pos = sgtNextOffice(p.pos);
        SGT.proBudget += n;
        msgs.push('困住 1 回合，期满起复，升一品阶');
        break;
      }
      case 'allDem': {
        SGT.players.forEach(q => { if (!q.finished) for (let k = 0; k < a.n; k++) q.pos = sgtPrevOffice(q.pos); });
        msgs.push(`满朝俱降 ${a.n} 品阶`);
        break;
      }
      case 'gamble': {
        const win = Math.random() < 0.5;
        msgs.push(win ? '时来运转——' : '时运不济——');
        msgs.push(...sgtApplyActs(p, win ? a.win : a.lose, chainDepth + 1));
        break;
      }
      case 'destiny': {
        const d = 1 + Math.floor(Math.random() * 6);
        if (d <= 3) {
          const up = d === 1 ? 3 : 2; // 1→升3，2/3→升2
          let n = up; if (SGT.proBudget + n > 3) n = 3 - SGT.proBudget;
          for (let k = 0; k < n; k++) p.pos = sgtNextOffice(p.pos);
          SGT.proBudget += n;
          msgs.push(`天命骰得 ${d} 点·吉，升 ${n} 品阶`);
        } else {
          for (let k = 0; k < 2; k++) p.pos = sgtPrevOffice(p.pos);
          msgs.push(`天命骰得 ${d} 点·凶，降 2 品阶`);
        }
        break;
      }
      // guiren / yubi / choice 由交互层单独处理，不在此
      default: break;
    }
  }
  return msgs;
}

// 前进/后退落入事件格 → 连锁（最多 2 次）
function sgtMaybeChain(p, msgs, chainDepth) {
  if (chainDepth >= 2) return;
  if (p.pos >= SGT_GOAL) return;
  const cell = SGT_BOARD[p.pos];
  if ((cell.kind === 'event' || cell.kind === 'rebel') && cell.fx.length && !cell.opts) {
    const onlyAuto = cell.fx.every(a => a.t !== 'choice' && a.t !== 'guiren' && a.t !== 'yubi' && a.t !== 'destiny');
    if (onlyAuto) {
      msgs.push(`〔连锁〕落于「${cell.text}」`);
      msgs.push(...sgtApplyActs(p, cell.fx, chainDepth + 1));
    }
  }
}

/* ------------------------------------------------------------
   七、回合流程控制
   ------------------------------------------------------------ */
function sgtCur() { return SGT.players[SGT.turn]; }
// 当前回合是否由真人操作道具（真人本人，或真人代管的托管队友）
function sgtHumanControlled(p) { return !p.isAI || p.humanItems; }

function sgtLog(html) {
  SGT.log.unshift(html);
  if (SGT.log.length > 40) SGT.log.pop();
  sgtRenderLog();
}

function sgtAdvanceTurn() {
  if (SGT.winner) return;
  let guard = 0;
  do {
    SGT.turn = (SGT.turn + 1) % SGT.players.length;
    guard++;
  } while (sgtCur().finished && guard < 20);
  SGT.proBudget = 0;
  SGT.phase = 'roll';
  sgtBeginTurn();
}

function sgtBeginTurn() {
  const p = sgtCur();
  sgtRenderAll();
  // 困住处理
  if (p.stuck > 0) {
    p.stuck--;
    sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 困于任上，跳过此回合（余 ${p.stuck} 回合）。`);
    sgtShowCenter(`<div class="sgt-ev-head">${p.name} 困于任上，无法行棋。</div>`);
    SGT.busy = true;
    setTimeout(() => { SGT.busy = false; sgtAdvanceTurn(); }, SGT_SPEED.stuckHold);
    return;
  }
  if (sgtHumanControlled(p)) {
    // 真人本人 / 真人代管的托管队友：手动决定是否用道具，再掷骰
    SGT.busy = false;
    sgtRenderControls();
    if (p.humanItems) {
      sgtShowCenter(`<div class="sgt-ev-head">轮到队友 <b style="color:${p.color.css}">${p.name}</b>（托管）——<br>由你决定是否替其使用道具，然后代为掷骰。</div>`);
    }
  } else {
    SGT.busy = true;
    setTimeout(() => sgtAiTurn(), SGT_SPEED.aiThink);
  }
}

// 弹劾令牌：使目标降一品阶
function sgtUseToken(targetId) {
  const p = sgtCur();
  if (p.tokens <= 0) return;
  const t = SGT.players.find(q => q.id === targetId);
  if (!t || t.finished) return;
  if (t.pos <= 0) { sgtToast('对方已在从九品，无可再降。'); return; }
  p.tokens--;
  t.pos = sgtPrevOffice(t.pos);
  sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 祭出弹劾令牌，参 <b style="color:${t.color.css}">${t.name}</b> 一本——降一品阶，贬至「${SGT_RANKS[sgtOfficeRankAt(t.pos)]}」。`);
  sgtFlash(t.id, 'bad');
  sgtRenderAll();
  sgtRenderControls();
}

// 禁足令：使目标下一回合不能掷骰
function sgtUseBan(targetId) {
  const p = sgtCur();
  if (p.bans <= 0) return;
  const t = SGT.players.find(q => q.id === targetId);
  if (!t || t.finished) return;
  p.bans--;
  t.stuck += 1;
  sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 祭出禁足令，锁 <b style="color:${t.color.css}">${t.name}</b> 于阙下——下一回合不得掷骰。`);
  sgtFlash(t.id, 'bad');
  sgtRenderAll();
  sgtRenderControls();
}

// 掷骰
function sgtRoll() {
  if (SGT.busy || SGT.phase !== 'roll') return;
  const p = sgtCur();
  SGT.busy = true;
  SGT.phase = 'resolving';
  sgtRenderControls();
  const d = 1 + Math.floor(Math.random() * 6);
  sgtRenderDice(d, () => {
    sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 掷得 <b>${d}</b> 点。`);
    sgtMovePlayer(p, d, () => sgtResolveLanding(p));
  });
}

// 逐格移动动画
function sgtMovePlayer(p, steps, done) {
  let left = steps;
  const step = () => {
    if (left <= 0 || p.pos >= SGT_GOAL) { done(); return; }
    p.pos = sgtClampPos(p.pos + 1);
    left--;
    sgtRenderBoard();
    if (p.pos >= SGT_GOAL) { done(); return; }
    setTimeout(step, SGT_SPEED.moveStep);
  };
  step();
}

// 落地结算
function sgtResolveLanding(p) {
  if (p.pos >= SGT_GOAL) { sgtWin(p); return; }
  const cell = SGT_BOARD[p.pos];
  let head = '';
  if (cell.kind === 'office' || cell.kind === 'start') head = `履新 <b>${cell.name}</b>。`;
  else if (cell.kind === 'fortune') head = `奇遇 · <b>${cell.name}</b>：${cell.text}`;
  else if (cell.kind === 'rebel') head = `<b style="color:var(--vermilion-2)">谋反！</b>${cell.text}`;
  else head = cell.text;

  // 需要玩家/AI 抉择的特殊格
  const special = cell.fx[0] && (cell.fx[0].t === 'choice' || cell.fx[0].t === 'guiren' || cell.fx[0].t === 'yubi');
  if (special) {
    sgtResolveSpecial(p, cell, head);
    return;
  }
  const msgs = sgtApplyActs(p, cell.fx, 0);
  sgtShowEvent(cell, head, msgs);
  sgtRenderAll();
  sgtEndResolution(p);
}

function sgtResolveSpecial(p, cell, head) {
  const a = cell.fx[0];
  // 抉择类一律由 AI 自动决断（含真人代管的托管队友——道具之外的抉择仍由 AI 决）
  if (a.t === 'choice') {
    if (p.isAI) {
      const pick = sgtAiChoose(p, cell.opts);
      const msgs = sgtApplyActs(p, cell.opts[pick].fx, 0);
      sgtShowEvent(cell, head + `〔择〕${cell.opts[pick].label}`, msgs);
      sgtRenderAll();
      sgtEndResolution(p);
    } else {
      SGT.phase = 'choice';
      sgtShowEvent(cell, head, null);
      sgtRenderChoiceButtons(cell, p);
    }
  } else if (a.t === 'yubi') {
    if (p.isAI) {
      const fwd = sgtPlayersAheadOf(p).length > 0 || p.pos < 60;
      sgtApplyYubi(p, fwd);
      sgtShowEvent(cell, head, [fwd ? '御笔朱圈——前进三阶' : '御笔朱圈——退后三阶']);
      sgtRenderAll(); sgtEndResolution(p);
    } else {
      SGT.phase = 'choice';
      sgtShowEvent(cell, head, null);
      sgtRenderYubiButtons(cell, p);
    }
  } else if (a.t === 'guiren') {
    if (p.isAI) {
      // 组队模式优先提携落后的队友，否则提携自己
      let target = p;
      const mates = sgtTeammates(p).filter(q => !q.finished);
      if (mates.length) { const m = mates.sort((x, y) => x.pos - y.pos)[0]; if (m.pos < p.pos) target = m; }
      sgtApplyGuiren(p, target.id);
      sgtShowEvent(cell, head, [`贵人提携 <b>${target.name}</b>，升一品阶`]);
      sgtRenderAll(); sgtEndResolution(p);
    } else {
      SGT.phase = 'choice';
      sgtShowEvent(cell, head, null);
      sgtRenderGuirenButtons(cell, p);
    }
  }
}

function sgtApplyYubi(p, forward) {
  if (forward) { let n = 3; if (SGT.proBudget + n > 3) n = 3 - SGT.proBudget; for (let k = 0; k < n; k++) p.pos = sgtNextOffice(p.pos); SGT.proBudget += n; }
  else { for (let k = 0; k < 3; k++) p.pos = sgtPrevOffice(p.pos); }
}
function sgtApplyGuiren(p, targetId) {
  const t = SGT.players.find(q => q.id === targetId);
  let n = 1; if (t === p) { if (SGT.proBudget + n > 3) n = 3 - SGT.proBudget; SGT.proBudget += n; }
  for (let k = 0; k < n; k++) t.pos = sgtNextOffice(t.pos);
  sgtFlash(t.id, 'good');
}

// 玩家完成抉择后调用
function sgtChoicePicked(idx) {
  const p = sgtCur();
  const cell = SGT_BOARD[p.pos];
  const msgs = sgtApplyActs(p, cell.opts[idx].fx, 0);
  sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 择「${cell.opts[idx].label}」：${msgs.join('，') || '无事'}。`);
  sgtShowEvent(cell, `${cell.text}〔择〕${cell.opts[idx].label}`, msgs);
  sgtRenderAll();
  sgtEndResolution(p);
}
function sgtYubiPicked(forward) {
  const p = sgtCur();
  sgtApplyYubi(p, forward);
  sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 奉御笔，${forward ? '前进三阶' : '退后三阶'}。`);
  sgtRenderAll();
  sgtEndResolution(p);
}
function sgtGuirenPicked(targetId) {
  const p = sgtCur();
  const t = SGT.players.find(q => q.id === targetId);
  sgtApplyGuiren(p, targetId);
  sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 援引贵人之力，擢 <b style="color:${t.color.css}">${t.name}</b> 升一品阶。`);
  sgtRenderAll();
  sgtEndResolution(p);
}

// 结算尾声：检查胜负 / 进入下一回合
function sgtEndResolution(p) {
  SGT.busy = false;
  if (p.pos >= SGT_GOAL) { sgtWin(p); return; }
  SGT.phase = 'roll';
  setTimeout(() => sgtAdvanceTurn(), p.isAI ? SGT_SPEED.aiEvent : SGT_SPEED.humanEvent);
}

function sgtWin(p) {
  p.finished = true;
  p.pos = SGT_GOAL;
  SGT.winner = p;
  SGT.winnerTeam = p.team;
  SGT.phase = 'over';
  SGT.busy = false;
  // 组队模式：全队同登榜首
  if (SGT.mode === 'team') {
    sgtTeammates(p).forEach(q => { q.finished = true; });
  }
  sgtRenderAll();
  const teamTxt = SGT.mode === 'team' ? `（${SGT_TEAM_NAME[p.team]}队）` : '';
  sgtLog(`🏆 <b style="color:${p.color.css}">${p.name}</b>${teamTxt} 升至正一品·太师，位极人臣，对局终了！`);
  sgtShowVictory(p);
}

/* ------------------------------------------------------------
   八、AI 决策（加权贪心，对应 GDD 七）
   ------------------------------------------------------------ */
function sgtPlayersAheadOf(p) {
  return SGT.players.filter(q => q !== p && !q.finished && q.pos > p.pos);
}
function sgtAiTurn() {
  const p = sgtCur();
  let used = false;
  // 0. 进商肆补货：钱够且未达上限则买（优先弹劾令）
  while (p.bought < SGT_SHOP.buyCap && (p.tokens + p.bans) < SGT_SHOP.holdCap) {
    if (p.coins >= SGT_SHOP.tokPrice) {
      p.coins -= SGT_SHOP.tokPrice; p.bought++; p.tokens++; used = true;
      sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 入商肆购弹劾令（余 ${p.coins} 缗）。`);
    } else if (p.coins >= SGT_SHOP.banPrice) {
      p.coins -= SGT_SHOP.banPrice; p.bought++; p.bans++; used = true;
      sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 入商肆购禁足令（余 ${p.coins} 缗）。`);
    } else break;
  }
  // 1. 弹劾令牌
  if (p.tokens > 0) {
    const target = sgtAiPickTarget(p, true);
    if (target) { sgtUseToken(target.id); used = true; }
  }
  // 2. 禁足令（优先封锁最接近终点的对手）
  if (p.bans > 0) {
    const target = sgtAiPickTarget(p, false);
    if (target) { sgtUseBan(target.id); used = true; }
  }
  // 3. 掷骰
  SGT.busy = false;
  setTimeout(() => sgtRoll(), used ? SGT_SPEED.aiItemHold : 500);
}
function sgtAiPickTarget(p, forImpeach) {
  const opp = sgtOpponents(p).filter(q => q.pos > 0);
  if (!opp.length) return null;
  // 逼近终点者（pos≥79）优先
  const threats = opp.filter(q => q.pos >= 98);
  if (threats.length) return threats.sort((a, b) => b.pos - a.pos)[0];
  // 其次：领先自己者，半概率出手
  const ahead = opp.filter(q => q.pos > p.pos);
  if (ahead.length && Math.random() < (forImpeach ? 0.5 : 0.4)) return ahead.sort((a, b) => b.pos - a.pos)[0];
  return null;
}
function sgtAiChoose(p, opts) {
  function score(fx) {
    let s = 0;
    for (const a of fx) {
      if (a.t === 'pro') s += a.n * 4;
      else if (a.t === 'adv') s += a.n;
      else if (a.t === 'dem') s -= a.n * 4;
      else if (a.t === 'ret') s -= a.n;
      else if (a.t === 'tok') s += a.n * 2.5;
      else if (a.t === 'ban') s += a.n * 2;
      else if (a.t === 'loseTok') s -= 2.5;
      else if (a.t === 'stuck') s -= a.n * 3;
      else if (a.t === 'gamble') s += 0;
    }
    return s;
  }
  let best = 0, bs = -1e9;
  opts.forEach((o, i) => { const sc = score(o.fx); if (sc > bs) { bs = sc; best = i; } });
  return best;
}

/* ============================================================
   九、渲染层 — 棋盘 / 玩家 / 控制 / 事件 / 骰子
   ============================================================ */
function sgtEl(id) { return document.getElementById(id); }

// 构建棋盘 DOM（一次）
function sgtBuildBoardDom() {
  const grid = sgtEl('sgtGrid');
  grid.innerHTML = '';
  grid.style.gridTemplateColumns = `repeat(${SGT_GRID_COLS}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${SGT_GRID_ROWS}, 1fr)`;
  SGT_BOARD.forEach((cell, i) => {
    const [r, c] = SGT_COORDS[i];
    const d = document.createElement('div');
    d.className = 'sgt-cell';
    d.id = 'sgt-cell-' + i;
    d.style.gridRow = (r + 1);
    d.style.gridColumn = (c + 1);
    if (cell.kind === 'office' || cell.kind === 'start' || cell.kind === 'goal') {
      d.classList.add('sgt-office', 'robe-' + cell.robe);
      if (cell.kind === 'start') d.classList.add('sgt-start');
      if (cell.kind === 'goal') d.classList.add('sgt-goal');
      const parts = cell.name.split('·');
      d.innerHTML = `<span class="sgt-c-rank">${parts[0]}</span><span class="sgt-c-name">${parts[1] || ''}</span>`;
    } else if (cell.kind === 'fortune') {
      d.classList.add('sgt-fortune');
      d.innerHTML = `<span class="sgt-c-badge b-fortune">奇</span><span class="sgt-c-name">${cell.name}</span>`;
    } else {
      d.classList.add('sgt-event');
      if (cell.kind === 'rebel') d.classList.add('sgt-rebel');
      const b = sgtFxBadge(cell);
      d.innerHTML = `<span class="sgt-c-badge ${b.cls}">${b.label}</span><span class="sgt-c-no">${i}</span>`;
    }
    d.onclick = () => sgtShowCellInfo(i);
    grid.appendChild(d);
  });
  // 中央牌匾（占据回字盘中央 11×7 空腔）
  const center = document.createElement('div');
  center.className = 'sgt-center';
  center.style.gridRow = '4 / 9';
  center.style.gridColumn = '4 / 13';
  center.innerHTML = `
    <div class="sgt-center-seal">升</div>
    <div class="sgt-center-title">大 宋 升 官 图</div>
    <div class="sgt-center-sub">掷骰竞官 · 先至太师者胜</div>
    <div class="sgt-dice-stage" id="sgtDiceStage">—</div>
    <div class="sgt-center-event" id="sgtCenterEvent"></div>`;
  grid.appendChild(center);
}

function sgtRenderAll() {
  if (SGT && SGT.players) SGT.players.forEach(sgtSyncCoins); // 钱财随品阶实时对账
  sgtRenderBoard(); sgtRenderStandings(); sgtRenderTurnBanner(); sgtRenderControls();
}

// 在格子上绘制棋子
function sgtRenderBoard() {
  document.querySelectorAll('.sgt-pawn').forEach(e => e.remove());
  document.querySelectorAll('.sgt-cell.active').forEach(e => e.classList.remove('active'));
  // 同格多子分布
  const occ = {};
  SGT.players.forEach((p, idx) => {
    const cell = sgtEl('sgt-cell-' + p.pos);
    if (!cell) return;
    const n = occ[p.pos] || 0; occ[p.pos] = n + 1;
    const pawn = document.createElement('div');
    pawn.className = 'sgt-pawn';
    pawn.style.background = p.color.css;
    pawn.style.left = (3 + (n % 2) * 50) + '%';
    pawn.style.top = (3 + Math.floor(n / 2) * 50) + '%';
    pawn.textContent = p.color.glyph;
    if (p === sgtCur()) pawn.classList.add('cur');
    cell.appendChild(pawn);
  });
  const c = sgtCur();
  if (c) { const cc = sgtEl('sgt-cell-' + c.pos); if (cc) cc.classList.add('active'); }
}

// 玩家榜：品阶 + 当前官名全称
function sgtRenderStandings() {
  const el = sgtEl('sgtStandings');
  if (!el) return;
  const ordered = SGT.players.map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.pos - a.p.pos);
  el.innerHTML = ordered.map(({ p }) => {
    const rank = sgtOfficeRankAt(p.pos);
    const isCur = p === sgtCur();
    const teamTag = SGT.mode === 'team'
      ? `<span class="sgt-team-tag team-${p.team}">${SGT_TEAM_NAME[p.team]}</span>` : '';
    const ctrlTag = p.isAI ? (p.humanItems ? '<i>·托管(你控道具)</i>' : '<i>·托管</i>') : '';
    const meta = [`令${p.tokens}`, `禁${p.bans}`, `钱${p.coins}`];
    if (p.stuck > 0) meta.push('困' + p.stuck);
    return `<div class="sgt-stand ${isCur ? 'cur' : ''} ${p.finished ? 'win' : ''}">
      <div class="sgt-stand-top">
        <span class="sgt-dot" style="background:${p.color.css}">${p.color.glyph}</span>
        ${teamTag}
        <span class="sgt-stand-name">${p.name}${ctrlTag}</span>
        <span class="sgt-stand-meta">${meta.join(' · ')}</span>
      </div>
      <div class="sgt-stand-office-row">
        <span class="sgt-stand-rank robe-txt-${sgtRobe(rank)}">${sgtRankTier(rank)}</span>
        <span class="sgt-stand-office">${sgtRankOffice(rank)}</span>
      </div>
    </div>`;
  }).join('');
}

function sgtRenderTurnBanner() {
  const el = sgtEl('sgtTurnBanner');
  if (!el) return;
  const p = sgtCur();
  const rank = sgtOfficeRankAt(p.pos);
  const teamTxt = SGT.mode === 'team' ? `<span class="sgt-team-tag team-${p.team}">${SGT_TEAM_NAME[p.team]}</span> ` : '';
  el.innerHTML = `当前 · ${teamTxt}<b style="color:${p.color.css}">${p.name}</b>　${SGT_RANKS[rank]}　<span class="robe-txt-${sgtRobe(rank)}">${sgtRobeName(rank)}</span>`;
}

// 操作区
function sgtRenderControls() {
  const el = sgtEl('sgtControls');
  if (!el) return;
  const p = sgtCur();
  if (SGT.phase === 'over') {
    el.innerHTML = `<button class="brush-btn" onclick="sgtRestart()">再 开 一 局</button>`;
    return;
  }
  // 抉择阶段由各自的 render 函数填充，这里不覆盖
  if (SGT.phase === 'choice') return;
  if (!sgtHumanControlled(p) || SGT.busy || SGT.phase !== 'roll') {
    el.innerHTML = `<div class="sgt-wait">${SGT.busy ? '· 推演中 ·' : '· 待 ' + p.name + ' 行棋 ·'}</div>`;
    return;
  }
  let html = '';
  if (p.tokens > 0) html += `<button class="brush-btn ghost sgt-tok-btn" onclick="sgtOpenImpeach()">用弹劾令（×${p.tokens}）<small>使一名对手降一品阶</small></button>`;
  if (p.bans > 0)   html += `<button class="brush-btn ghost sgt-tok-btn" onclick="sgtOpenBan()">用禁足令（×${p.bans}）<small>使一名对手停掷一回合</small></button>`;
  html += `<button class="brush-btn ghost sgt-tok-btn" onclick="sgtOpenShop()">进 商 肆（${p.coins} 缗）<small>购弹劾令 / 禁足令</small></button>`;
  const rollLabel = p.humanItems ? '代 队 友 掷 骰' : '掷 骰 子';
  html += `<button class="brush-btn" onclick="sgtRoll()">${rollLabel}</button>`;
  el.innerHTML = html;
}

// 骰子动画
function sgtRenderDice(final, done) {
  const stage = sgtEl('sgtDiceStage');
  const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  let n = 0;
  const spin = () => {
    n++;
    stage.textContent = faces[Math.floor(Math.random() * 6)];
    stage.classList.add('rolling');
    if (n < SGT_SPEED.diceSpins) setTimeout(spin, SGT_SPEED.diceSpin);
    else {
      stage.textContent = faces[final - 1] + ' ' + final;
      stage.classList.remove('rolling');
      setTimeout(done, SGT_SPEED.diceSettle);
    }
  };
  spin();
}

// 中央牌匾通用展示
function sgtShowCenter(html) {
  const el = sgtEl('sgtCenterEvent');
  if (!el) return;
  el.innerHTML = html;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
}

// 中央事件展示
function sgtShowEvent(cell, head, msgs) {
  let body = `<div class="sgt-ev-head">${head}</div>`;
  if (msgs && msgs.length) body += `<div class="sgt-ev-msgs">${msgs.join('　')}</div>`;
  sgtShowCenter(body);
  if (msgs) {
    const p = sgtCur();
    sgtLog(`<b style="color:${p.color.css}">${p.name}</b>：${cell.name || cell.text.slice(0, 12)}${msgs.length ? '——' + msgs.join('，') : ''}`);
  }
}

function sgtRenderLog() {
  const el = sgtEl('sgtLog');
  if (!el) return;
  el.innerHTML = SGT.log.map(l => `<div class="sgt-log-row">${l}</div>`).join('');
}

// 抉择按钮
function sgtRenderChoiceButtons(cell, p) {
  const el = sgtEl('sgtControls');
  el.innerHTML = cell.opts.map((o, i) =>
    `<button class="brush-btn sgt-choice" onclick="sgtChoicePicked(${i})">${o.label}<small>${o.hint}</small></button>`
  ).join('');
}
function sgtRenderYubiButtons(cell, p) {
  const el = sgtEl('sgtControls');
  el.innerHTML = `<button class="brush-btn sgt-choice" onclick="sgtYubiPicked(true)">前进三阶<small>跳至前方第三官职格</small></button>
                  <button class="brush-btn ghost sgt-choice" onclick="sgtYubiPicked(false)">退后三阶<small>退至后方第三官职格</small></button>`;
}
function sgtRenderGuirenButtons(cell, p) {
  const el = sgtEl('sgtControls');
  el.innerHTML = SGT.players.filter(q => !q.finished).map(q =>
    `<button class="brush-btn ghost sgt-choice" onclick="sgtGuirenPicked('${q.id}')">
       提携 <span style="color:${q.color.css}">${q.name}</span>${q === p ? '（自己）' : ''}<small>升一品阶</small></button>`
  ).join('');
}

// 弹劾选择面板
function sgtOpenImpeach() {
  const el = sgtEl('sgtControls');
  const p = sgtCur();
  const targets = sgtOpponents(p).filter(q => q.pos > 0);
  if (!targets.length) { sgtToast('无可弹劾之人。'); return; }
  el.innerHTML = targets.map(q =>
    `<button class="brush-btn ghost sgt-choice" onclick="sgtUseToken('${q.id}')">
       参 <span style="color:${q.color.css}">${q.name}</span> 一本<small>使其降一品阶</small></button>`
  ).join('') + `<button class="brush-btn sgt-choice" onclick="sgtRenderControls()">返回</button>`;
}

// 禁足选择面板
function sgtOpenBan() {
  const el = sgtEl('sgtControls');
  const p = sgtCur();
  const targets = sgtOpponents(p);
  if (!targets.length) { sgtToast('无可禁足之人。'); return; }
  el.innerHTML = targets.map(q =>
    `<button class="brush-btn ghost sgt-choice" onclick="sgtUseBan('${q.id}')">
       锁 <span style="color:${q.color.css}">${q.name}</span> 于阙下<small>使其下一回合不得掷骰</small></button>`
  ).join('') + `<button class="brush-btn sgt-choice" onclick="sgtRenderControls()">返回</button>`;
}

// 商肆面板（v1.2）
function sgtOpenShop() {
  const el = sgtEl('sgtControls');
  const p = sgtCur();
  const held = p.tokens + p.bans;
  const mk = (kind, label, price) => {
    const reasons = [];
    if (p.bought >= SGT_SHOP.buyCap) reasons.push('本局已购满');
    if (held >= SGT_SHOP.holdCap) reasons.push('持有已满');
    if (p.coins < price) reasons.push('钱财不足');
    const dis = reasons.length > 0;
    return `<button class="brush-btn ghost sgt-choice" ${dis ? 'disabled' : ''} onclick="sgtBuyItem('${kind}')">
      购 ${label}（${price} 缗）<small>${dis ? reasons[0] : '立即入手'}</small></button>`;
  };
  el.innerHTML =
    `<div class="sgt-shop-hd">商肆 · 现银 <b>${p.coins}</b> 缗　本局已购 ${p.bought}/${SGT_SHOP.buyCap}　持有 ${held}/${SGT_SHOP.holdCap}</div>`
    + mk('tok', '弹劾令', SGT_SHOP.tokPrice)
    + mk('ban', '禁足令', SGT_SHOP.banPrice)
    + `<button class="brush-btn sgt-choice" onclick="sgtRenderControls()">返回</button>`;
}
function sgtBuyItem(kind) {
  const p = sgtCur();
  if (!sgtHumanControlled(p) || SGT.busy || SGT.phase !== 'roll') return;
  const price = kind === 'tok' ? SGT_SHOP.tokPrice : SGT_SHOP.banPrice;
  if (p.bought >= SGT_SHOP.buyCap) { sgtToast('本局购买已达上限（3 件）。'); return; }
  if (p.tokens + p.bans >= SGT_SHOP.holdCap) { sgtToast('持有道具已满（3 件），用掉再买。'); return; }
  if (p.coins < price) { sgtToast(`钱财不足，需 ${price} 缗（现有 ${p.coins} 缗）。`); return; }
  p.coins -= price; p.bought++;
  if (kind === 'tok') p.tokens++; else p.bans++;
  const nm = kind === 'tok' ? '弹劾令' : '禁足令';
  sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 入商肆，购得${nm}一道（耗 ${price} 缗，余 ${p.coins} 缗）。`);
  sgtRenderAll();
  sgtOpenShop();
}

// 棋子/格子高亮
function sgtFlash(playerId, kind) {
  const p = SGT.players.find(q => q.id === playerId);
  if (!p) return;
  const cell = sgtEl('sgt-cell-' + p.pos);
  if (cell) { cell.classList.add('flash-' + kind); setTimeout(() => cell.classList.remove('flash-' + kind), 600); }
}

let sgtToastTimer = null;
function sgtToast(msg, dur) {
  const t = sgtEl('sgtToast');
  if (!t) return;
  if (sgtToastTimer) clearTimeout(sgtToastTimer);
  t.innerHTML = msg; t.classList.add('show');
  sgtToastTimer = setTimeout(() => t.classList.remove('show'), dur || 1600);
}

// 点击格子查看信息（v1.2：浮层延时 4.5s，并追加效果摘要）
function sgtShowCellInfo(i) {
  const cell = SGT_BOARD[i];
  let s = `<b>#${i}</b> · `;
  if (cell.kind === 'office' || cell.kind === 'start' || cell.kind === 'goal') {
    s += `官职格 <b>${cell.name}</b>（${sgtRobeName(cell.rank)}）　${cell.text}`;
  } else {
    if (cell.kind === 'fortune') s += `奇遇 · <b>${cell.name}</b>：${cell.text}`;
    else if (cell.kind === 'rebel') s += `<b>谋反</b> · ${cell.text}`;
    else s += cell.text;
    s += `　<span class="sgt-toast-fx">【效果：${sgtFxText(cell)}】</span>`;
  }
  sgtToast(s, 4500);
}

// 胜利浮层
function sgtShowVictory(p) {
  const ov = sgtEl('sgtVictory');
  sgtEl('sgtVicName').innerHTML = SGT.mode === 'team'
    ? `${SGT_TEAM_NAME[p.team]}队　<span style="color:${p.color.css}">${p.name}</span> 等`
    : `<span style="color:${p.color.css}">${p.name}</span>`;
  const rankList = SGT.players.slice().sort((a, b) => b.pos - a.pos);
  sgtEl('sgtVicList').innerHTML = rankList.map((q, i) => {
    const teamTag = SGT.mode === 'team' ? `<span class="sgt-team-tag team-${q.team}">${SGT_TEAM_NAME[q.team]}</span>` : '';
    return `<div class="sgt-vic-row"><span>${['第一甲', '第二甲', '第三甲', '第四甲'][i]}</span>
     <span>${teamTag}<span style="color:${q.color.css}">${q.name}</span></span>
     <span>${sgtRankTier(sgtOfficeRankAt(q.pos))}</span></div>`;
  }).join('');
  ov.classList.remove('hidden');
  ov.classList.add('show');
}
function sgtCloseVictory() { const ov = sgtEl('sgtVictory'); ov.classList.add('hidden'); ov.classList.remove('show'); }

/* ============================================================
   十、开局设置 与 引导
   ============================================================ */
function sgtCurrentMode() {
  const r = document.querySelector('input[name="sgtMode"]:checked');
  return r ? r.value : 'free';
}

function sgtStartGame() {
  const mode = sgtCurrentMode();
  let players;
  if (mode === 'team') {
    // 2v2：甲队（你 帥 + 队友 仕，皆朱红）vs 乙队（对手 將 + 士，皆靛蓝）
    // 同队同色仅棋子字不同；回合次序交错：甲-乙-甲-乙
    const humans = parseInt((document.querySelector('input[name="sgtTeamHumans"]:checked') || {}).value || '1', 10);
    const base = () => ({ pos: 0, tokens: 0, bans: 0, stuck: 0, coins: 0, bought: 0, rank: 0, finished: false });
    players = [
      Object.assign({ id: 'P0', name: '你·帥', color: sgtTeamColor(0, 0), team: 0, isAI: false, humanItems: false }, base()),
      Object.assign({ id: 'P1', name: '对手·將（托管）', color: sgtTeamColor(1, 0), team: 1, isAI: true, humanItems: false }, base()),
      Object.assign({ id: 'P2', name: (humans === 2 ? '队友·仕' : '队友·仕（托管）'), color: sgtTeamColor(0, 1), team: 0, isAI: humans === 1, humanItems: humans === 1 }, base()),
      Object.assign({ id: 'P3', name: '对手·士（托管）', color: sgtTeamColor(1, 1), team: 1, isAI: true, humanItems: false }, base())
    ];
    sgtNewGame(players, 'team');
    SGT.turn = -1;
  } else {
    const count = parseInt(document.querySelector('input[name="sgtCount"]:checked').value, 10);
    players = [];
    for (let i = 0; i < count; i++) {
      let isAI = false;
      if (i > 0) {
        const radio = document.querySelector(`input[name="sgtPlayMode${i}"]:checked`);
        isAI = !radio || radio.value === 'ai';
      }
      players.push({
        id: 'P' + i, name: (i === 0 ? '你·' : '') + SGT_COLORS[i].name + (i === 0 ? '' : (isAI ? '（托管）' : '')),
        color: SGT_COLORS[i], team: null, isAI, humanItems: false,
        pos: 0, tokens: 0, bans: 0, stuck: 0, coins: 0, bought: 0, rank: 0, finished: false
      });
    }
    players.sort(() => Math.random() - 0.5); // 随机先后手
    sgtNewGame(players, 'free');
    SGT.turn = -1;
  }
  sgtEl('sgtSetup').classList.add('hidden');
  sgtEl('sgtPlay').classList.remove('hidden');
  sgtBuildBoardDom();
  SGT.log = [];
  sgtLog('— 群贤毕集，自从九品·太常寺奉礼郎起步，先至正一品·太师者胜。 —');
  sgtAdvanceTurn();
}

function sgtRestart() {
  sgtCloseVictory();
  sgtEl('sgtPlay').classList.add('hidden');
  sgtEl('sgtSetup').classList.remove('hidden');
  SGT = null;
}
// sgtBackHome removed — standalone version

// 设置界面：根据模式切换「自由对战 / 2v2 组队」面板，并刷新人数/托管选项
function sgtRenderSetup() {
  const mode = sgtCurrentMode();
  const freeBox = sgtEl('sgtFreeBox');
  const teamBox = sgtEl('sgtTeamBox');
  if (freeBox) freeBox.classList.toggle('hidden', mode !== 'free');
  if (teamBox) teamBox.classList.toggle('hidden', mode !== 'team');
  if (mode === 'free') sgtRenderModeRows();
}

function sgtRenderModeRows() {
  const countEl = document.querySelector('input[name="sgtCount"]:checked');
  if (!countEl) return;
  const count = parseInt(countEl.value, 10);
  const wrap = sgtEl('sgtModeRows');
  let html = '';
  for (let i = 1; i < count; i++) {
    html += `<div class="sgt-mode-row">
      <span class="sgt-mode-label"><span class="sgt-dot" style="background:${SGT_COLORS[i].css}">${SGT_COLORS[i].glyph}</span>${SGT_COLORS[i].name}</span>
      <label><input type="radio" name="sgtPlayMode${i}" value="ai" checked> AI 托管</label>
      <label><input type="radio" name="sgtPlayMode${i}" value="manual"> 手动</label>
    </div>`;
  }
  wrap.innerHTML = html || '<div class="sgt-mode-row"><em>· 单人独行，自起点直奔太师 ·</em></div>';
}

/* 说明书 / 文化卷轴浮层（v1.2） */
function sgtOpenSheet(id) {
  const el = sgtEl(id);
  if (!el) return;
  el.classList.remove('hidden');
  void el.offsetWidth;
  el.classList.add('show');
  const sc = el.querySelector('.sgt-sheet-scroll');
  if (sc) sc.scrollTop = 0;
}
function sgtCloseSheet(id) {
  const el = sgtEl(id);
  if (!el) return;
  el.classList.remove('show');
  setTimeout(() => el.classList.add('hidden'), 320);
}

function sgtInit() {
  document.querySelectorAll('input[name="sgtMode"]').forEach(r => r.addEventListener('change', sgtRenderSetup));
  document.querySelectorAll('input[name="sgtCount"]').forEach(r => r.addEventListener('change', sgtRenderModeRows));
  sgtRenderSetup();
}
document.addEventListener('DOMContentLoaded', sgtInit);
