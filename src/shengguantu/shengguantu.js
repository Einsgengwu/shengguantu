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
  tokPrice: 450,  // 弹劾令售价（缗）
  banPrice: 600,  // 禁足令售价（缗）
  holdCap:  3,    // 弹劾令/禁足令 同时持有上限（含事件赠予；单局购买不限，唯持有受此约束）
  dicePrice: 520, // 定数骰售价（缗）
  diceHold: 2,    // 定数骰 同时持有上限（独立计，不占弹劾/禁足之持有栏；单局购买不限）
  guardPrice: 620, // 护身符售价（缗）
  guardHold: 2     // 护身符 同时持有上限（独立计，不占弹劾/禁足之持有栏；单局购买不限）
};
// 升/降「第 r 阶」对应的财货增减：品阶越高单级越值钱
function sgtRankReward(r) { return r * 14; }
// 依当前品阶与上次记录对账钱财（升加、降减，下限 0）。幂等。
function sgtSyncCoins(p) {
  const nr = sgtOfficeRankAt(p.pos);
  if (nr > p.rank) { for (let r = p.rank + 1; r <= nr; r++) p.coins += sgtRankReward(r); }
  else if (nr < p.rank) { for (let r = p.rank; r > nr; r--) p.coins -= sgtRankReward(r); }
  if (p.coins < 0) p.coins = 0;
  p.rank = nr;
}

/* ------------------------------------------------------------
   捐纳买官 与 谋反篡位（v2.0）
   ------------------------------------------------------------ */
// 捐纳买官：仅以下数个官阶可捐（从八品/从七品上/从六品上/从五品上/从四品），直升对应官阶
const SGT_OFFICE_BUY = {
  ranks: [3, 6, 8, 10, 13],               // 可捐之官（rank）：从八品/从七品上/从六品上/从五品上/从四品
  price: function (r) { return r * 50; }   // 第 r 阶官位价（缗）。正五品上(第12阶)=600，亦为贪墨横财之上限
};
// 谋反篡位：高位区一格，低概率直接篡位称帝胜出，败则直贬回起点
const SGT_COUP = {
  // 篡位投骰：6→篡位成功登基称帝；4→退 4 品阶并困 1 回合；余点(1/2/3/5)→直贬回起点（皆无道具所得）
  winFace: 6, demFace: 4, demSteps: 4
};

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
     coin N（钱财±，下限0）/ immune N（护身符）
     allDem N / destiny / yubi / gamble
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
// 反查：官职 rank → board index（捐纳买官用）
const SGT_OFFICE_BY_RANK = {};
SGT_OFFICE_IDX.forEach(idx => { SGT_OFFICE_BY_RANK[SGT_OFFICE[idx]] = idx; });

// 事件/奇遇格定义（未列出的官职格由 SGT_OFFICE 生成）
// v1.1：三环 120 格 → 98 事件/奇遇格。绿袍温和、绯袍党争渐起、紫袍凶险。
const SGT_EVENTS = {
  /* ── 绿袍区（南/外环前段，官职格 0/5/10/16/22/28/34）── */
  1:  { text: '初入仕途，战战兢兢，唯恐失仪。', fx: [] },
  2:  { text: '抄写公文，字迹工整，为长官所赏。', fx: [{ t: 'adv', n: 1 }] },
  3:  { text: '户曹核账，往来奔走一日，无功无过。', fx: [] },
  4:  { text: '晨谒省门，谨守班次，无功无过。', fx: [] },
  6:  { text: '馆阁读书，博览群籍，学问大进。', fx: [{ t: 'pro', n: 1 }] },
  7:  { text: '兢兢业业，考课连年优等。', fx: [{ t: 'adv', n: 2 }] },
  8:  { text: '校雠典籍，按部就班，平平度日。', fx: [] },
  9:  { text: '风平浪静，案牍无事。', fx: [] },
  11: { text: '公文往来，循例办理，未见波澜。', fx: [] },
  12: { text: '随长官巡查诸县，表现干练。', fx: [{ t: 'adv', n: 2 }] },
  13: {
    text: '寺监账目积弊已久，长官以目示意——可瞒可报，亦可暗中弥缝。账册在手，一念定祸福。', fx: [{ t: 'choice' }],
    opts: [
      { label: '一力担责', flavor: '独引其咎，以全僚属', fx: [{ t: 'ret', n: 2 }, { t: 'tok', n: 1 }] },
      { label: '秉笔纠举', flavor: '直书无隐，听凭公论', fx: [{ t: 'gamble', win: [{ t: 'adv', n: 1 }], lose: [{ t: 'ret', n: 2 }] }] },
      { label: '暗中弥缝', flavor: '倾囊打点，但求无事', fx: [{ t: 'coin', n: -150 }] }
    ]
  },
  14: { text: '路遇同年，把酒言欢，互道契阔。', fx: [] },
  15: { kind: 'fortune', name: '御笔亲批', text: '一道御笔忽下，权衡在我——或自升三阶，或令一对手退后三阶（最低至起点）。', fx: [{ t: 'yubi' }] },
  17: { text: '初膺台谏之选，风闻奏事，权柄初染。', fx: [{ t: 'tok', n: 1 }] },
  18: { text: '弹劾不实，反坐其罪。', fx: [{ t: 'dem', n: 1 }] },
  19: { text: '下乡劝农，循行阡陌，安然而返。', fx: [] },
  20: { text: '本地豪商携赀相结，欲假尔之手通融关市、夤缘小利。', fx: [{ t: 'graft' }] },  // 进财格·低位（官商勾结）
  21: { text: '州府举荐贤良方正，名达于朝。', fx: [{ t: 'pro', n: 1 }, { t: 'adv', n: 1 }] },
  23: { text: '殿中纠仪，严正不阿，台纲肃然。', fx: [{ t: 'tok', n: 1 }] },
  24: { text: '为权贵所嫉恨，遭其党羽弹劾。', fx: [{ t: 'dem', n: 1 }] },
  25: { text: '掌州门管钥，可阻人于关下。', fx: [{ t: 'ban', n: 1 }] },
  26: {
    text: '同僚结党相轧，处处掣肘，明枪暗箭防不胜防——你孤身一人，何以自处？', fx: [{ t: 'choice' }],
    opts: [
      { label: '隐忍待时', flavor: '韬光养晦，徐图后举', fx: [{ t: 'ret', n: 1 }] },
      { label: '奋起反击', flavor: '针锋相对，不让分毫', fx: [{ t: 'gamble', win: [{ t: 'tok', n: 1 }], lose: [{ t: 'dem', n: 1 }] }] },
      { label: '改换门庭', flavor: '别寻奥援，另结新知', fx: [{ t: 'gamble', win: [{ t: 'adv', n: 2 }], lose: [{ t: 'ret', n: 2 }] }] }
    ]
  },
  27: { text: '值夜禁中，拾遗金不昧，帝闻而嘉之。', fx: [{ t: 'pro', n: 1 }] },
  29: {
    text: '欲上书直陈教学积弊，然忤旨恐贾祸，缄默又负初心——笔锋将如何落下？', fx: [{ t: 'choice' }],
    opts: [
      { label: '犯颜直谏', flavor: '披肝沥胆，不避雷霆', fx: [{ t: 'gamble', win: [{ t: 'pro', n: 1 }], lose: [{ t: 'dem', n: 1 }] }] },
      { label: '密疏婉陈', flavor: '迂回进言，留有余地', fx: [{ t: 'tok', n: 1 }, { t: 'ret', n: 1 }] },
      { label: '缄默自保', flavor: '明哲守拙，徐俟其时', fx: [] }
    ]
  },
  30: { text: '门生科举高中，师以为荣。', fx: [{ t: 'pro', n: 1 }] },
  31: { text: '博士论经，各执一词，不了了之。', fx: [] },
  32: { text: '奉使劳军，军中赠一副犀角骰子，骰面温润，似有神助。', fx: [{ t: 'dicetok', n: 1 }] },
  33: { text: '弹劾巨贪，一战成名，朝野侧目。', fx: [{ t: 'pro', n: 1 }, { t: 'tok', n: 1 }] },

  /* ── 绯袍区（东/内环前段，官职格 40/46/52/58/63/68）── */
  35: { text: '太学授课，发明经义，士子景从。', fx: [{ t: 'adv', n: 2 }] },
  36: { text: '撰文偶触庙讳，交部察议。', fx: [{ t: 'dem', n: 1 }] },
  37: { text: '编纂《日历》，一字之褒，荣于华衮。', fx: [] },
  38: { text: '上《时务策》十篇，切中时弊。', fx: [{ t: 'pro', n: 1 }] },
  39: { text: '修史之暇，翻检旧档，得前朝名臣手札一封，可作护身之凭。', fx: [{ t: 'immune', n: 1 }] },
  41: { text: '秘阁校书，于乱帙中拾得一枚古骰，相传可定数随心。', fx: [{ t: 'dicetok', n: 1 }] },
  42: { text: '丁忧守制，归乡庐墓。守孝名节，朝廷起复。', fx: [{ t: 'dingyou' }] },
  43: { text: '被借调修《会要》，预闻典章。', fx: [{ t: 'pro', n: 1 }] },
  44: { kind: 'fortune', name: '紫微星动', text: '紫微垣中，将星忽明忽暗——掷一枚天命之骰，吉凶未卜。', fx: [{ t: 'destiny' }] },
  45: { text: '东宫讲读，太子敬服，待以师礼。', fx: [{ t: 'pro', n: 1 }] },
  47: {
    text: '东宫失德，连坐之责难逃——是犯颜苦谏以匡君，引咎自请以避祸，还是曲意逢迎以求安？', fx: [{ t: 'choice' }],
    opts: [
      { label: '犯颜苦谏', flavor: '正色匡君，不恤己身', fx: [{ t: 'gamble', win: [{ t: 'pro', n: 1 }], lose: [{ t: 'dem', n: 1 }] }] },
      { label: '引咎请外', flavor: '自请补外，远嫌避谤', fx: [{ t: 'dem', n: 1 }, { t: 'coin', n: 200 }] },
      { label: '曲意将顺', flavor: '阿谀承欢，但求自安', fx: [{ t: 'gamble', win: [{ t: 'adv', n: 1 }], lose: [{ t: 'dem', n: 1 }] }] }
    ]
  },
  48: { text: '省中主事，案牍井井，权柄渐重。', fx: [{ t: 'tok', n: 1 }] },
  49: { text: '经手六部钱粮，出入皆由己手，公帑可乘隙暗入私囊。', fx: [{ t: 'graft' }] },  // 进财格·中位（贪墨公帑）
  50: { text: '新政推行，建言被纳，圣眷渐隆。', fx: [{ t: 'pro', n: 1 }, { t: 'adv', n: 1 }] },
  51: { text: '巡按一路，举劾贪墨，风裁凛然。', fx: [{ t: 'adv', n: 2 }] },
  53: {
    text: '权相设宴相邀，杯觥交错间意在罗致门下——这一席酒，该如何吃下？', fx: [{ t: 'choice' }],
    opts: [
      { label: '攀附权门', flavor: '纳身相门，荣辱与共', fx: [{ t: 'pro', n: 1 }, { t: 'loseTok' }] },
      { label: '半就半推', flavor: '不动声色，暗收苞苴', fx: [{ t: 'coin', n: 300 }, { t: 'ret', n: 1 }] },
      { label: '婉拒其请', flavor: '辞色温然，守身如玉', fx: [{ t: 'tok', n: 1 }] }
    ]
  },
  54: {
    text: '欲上《时政十弊疏》，激切恐贾祸，温和恐无益——奏章措辞，分寸最难拿捏。', fx: [{ t: 'choice' }],
    opts: [
      { label: '激切陈词', flavor: '直声震主，虽千万人吾往', fx: [{ t: 'pro', n: 1 }, { t: 'stuck', n: 1 }] },
      { label: '危言耸听', flavor: '耸动天听，孤注一掷', fx: [{ t: 'gamble', win: [{ t: 'pro', n: 1 }], lose: [{ t: 'ret', n: 1 }, { t: 'stuck', n: 1 }] }] },
      { label: '温言敷奏', flavor: '平和持中，不痛不痒', fx: [] }
    ]
  },
  55: { text: '封驳不当，被斥越权。', fx: [{ t: 'dem', n: 1 }] },
  56: { text: '封驳诏书，面折廷争，不避权要。', fx: [{ t: 'pro', n: 1 }, { t: 'tok', n: 1 }] },
  57: { text: '朝议新法，慷慨陈词，四座动容。', fx: [{ t: 'adv', n: 2 }] },
  59: { kind: 'fortune', name: '御笔再批', text: '御笔再下，权衡在我——或自升三阶，或择一对手令其退后三阶（最低至起点）。', fx: [{ t: 'yubi' }] },
  60: { text: '主持省试，得人甚盛，门下多俊彦。', fx: [{ t: 'pro', n: 1 }] },
  61: { text: '科举舞弊案起，被无端牵连。', fx: [{ t: 'dem', n: 1 }, { t: 'stuck', n: 1 }] },
  62: { text: '奏请扩太学，养士育才，获准。', fx: [{ t: 'adv', n: 2 }, { t: 'tok', n: 1 }] },
  64: { text: '太学刻石经，功在文教，名垂学宫。', fx: [{ t: 'pro', n: 1 }] },
  65: { text: '掌出入禁钥，可锁人于阙下。', fx: [{ t: 'ban', n: 1 }] },
  66: { text: '漕务繁冗，文牍盈案，按例签押而已。', fx: [] },
  67: { text: '总领盐铁漕运，巨贾豪商夤夜馈遗，源源不绝。', fx: [{ t: 'graft' }] },  // 进财格·高位（私通盐铁，赃银更巨）

  /* ── 紫袍区（北/西/最内环，官职格 74/80/86/92/98/104/109/114/119）── */
  69: { text: '掌铨选，举贤不避仇，时论称公。', fx: [{ t: 'pro', n: 1 }] },
  70: { text: '铨选失当，遭御史弹劾。', fx: [{ t: 'dem', n: 1 }] },
  71: { text: '综理庶务，握堂帖之权，能羁縻同列。', fx: [{ t: 'tok', n: 1 }] },
  72: {
    text: '尚书省骤起大火，案牍文牍顷刻将焚——浓烟之中，你的脚步迈向何方？', fx: [{ t: 'choice' }],
    opts: [
      { label: '冒火抢档', flavor: '舍身护牍，搏一场功名', fx: [{ t: 'gamble', win: [{ t: 'adv', n: 2 }], lose: [{ t: 'ret', n: 2 }] }] },
      { label: '趁乱取利', flavor: '火中取栗，浑水摸鱼', fx: [{ t: 'gamble', win: [{ t: 'coin', n: 300 }], lose: [{ t: 'dem', n: 1 }] }] },
      { label: '引咎自责', flavor: '俯首待罪，但求无大过', fx: [{ t: 'ret', n: 2 }] }
    ]
  },
  73: { text: '参预密勿，与闻军国大政。', fx: [{ t: 'pro', n: 1 }] },
  75: { text: '两府争议，居中调停有功。', fx: [{ t: 'adv', n: 2 }] },
  76: { kind: 'rebel', name: '谋反', text: '权臣密谋拥立，事泄败露！褫夺官身、贬为白丁、押回原籍——然旧部暗通款曲，遗你弹劾之柄。', fx: [{ t: 'rebel' }] },
  77: { text: '编修《国史》告竣，藏之秘阁。', fx: [{ t: 'pro', n: 1 }, { t: 'adv', n: 1 }] },
  78: {
    text: '党争正炽，新旧两党争相罗致——这一步站位，关乎日后荣枯生死。', fx: [{ t: 'choice' }],
    opts: [
      { label: '投身新党', flavor: '附骥攀鳞，风口搏浪', fx: [{ t: 'gamble', win: [{ t: 'adv', n: 2 }], lose: [{ t: 'ret', n: 2 }] }] },
      { label: '两边逢迎', flavor: '左右周旋，骑墙观望', fx: [{ t: 'ban', n: 1 }, { t: 'ret', n: 1 }] },
      { label: '超然中立', flavor: '高蹈远引，不入漩涡', fx: [] }
    ]
  },
  79: { text: '三朝耆旧，静坐讲筵，安享清班。', fx: [] },
  81: { text: '掌百官铨衡，位高权重，门庭若市。', fx: [{ t: 'pro', n: 1 }, { t: 'tok', n: 1 }] },
  82: { text: '一朝天子一朝臣——新君即位，旧臣俱受裁抑。', fx: [{ t: 'allDem', n: 1 }] },
  83: { text: '新君励精图治，选贤与能，特加擢用。', fx: [{ t: 'adv', n: 2 }] },
  84: { text: '入主政事堂，秉钧当轴，天下仰望。', fx: [{ t: 'pro', n: 1 }] },
  85: { text: '权倾朝野，谏官侧目，赐你言事之柄。', fx: [{ t: 'tok', n: 1 }] },
  87: { text: '边衅骤起，荐你筹边，措置咸宜。', fx: [{ t: 'adv', n: 2 }] },
  88: {
    text: '朋党之祸将兴，株连大狱已在眼前——危局之中，何以脱身？', fx: [{ t: 'choice' }],
    opts: [
      { label: '割席自清', flavor: '断交明志，避祸全身', fx: [{ t: 'ret', n: 1 }] },
      { label: '暗通门路', flavor: '夤夜走谒，纳赂求庇', fx: [{ t: 'coin', n: 250 }, { t: 'gamble', win: [], lose: [{ t: 'dem', n: 1 }] }] },
      { label: '抢先首告', flavor: '反戈一击，以人头自赎', fx: [{ t: 'gamble', win: [{ t: 'tok', n: 1 }], lose: [{ t: 'dem', n: 1 }] }] }
    ]
  },
  89: { text: '调和鼎鼐，燮理阴阳，朝纲为之一肃。', fx: [{ t: 'pro', n: 1 }] },
  90: {
    kind: 'fortune', name: '贵人相助',
    text: '朝中贵人念旧，愿有所相助——荐拔、馈赠、庇荫，皆在你一言之间。所求为何？', fx: [{ t: 'choice' }],
    opts: [
      { label: '求其荐拔', flavor: '托其美言，扶摇直上', fx: [{ t: 'pro', n: 1 }] },
      { label: '求其馈赠', flavor: '受其周济，囊橐渐丰', fx: [{ t: 'coin', n: 280 }] },
      { label: '求其庇护', flavor: '求一道护身符，以备暗箭', fx: [{ t: 'immune', n: 1 }] }
    ]
  },
  91: { text: '言官交章，劾你专权擅政。', fx: [{ t: 'dem', n: 1 }] },
  93: { text: '议立储贰，谋虑深远，圣心嘉纳。', fx: [{ t: 'pro', n: 1 }] },
  94: { text: '灾异示警，循例斋戒禳禬，内侍暗递护身符一枚，或可挡一回暗箭。', fx: [{ t: 'immune', n: 1 }] },
  95: { text: '总领台谏，纠弹百僚，威权在握。', fx: [{ t: 'ban', n: 1 }] },
  96: { text: '边帅失律丧师，荐主连坐受责。', fx: [{ t: 'dem', n: 1 }] },
  97: { text: '燮和天下，海内乂安，颂声四起。', fx: [{ t: 'adv', n: 2 }] },
  99: { text: '进位三公，恩荣冠世，剑履殊礼。', fx: [{ t: 'pro', n: 1 }] },
  100: {
    text: '先帝顾命之托忽然降临——受之则身系社稷、辞之则明哲全身，这副重担你接是不接？', fx: [{ t: 'choice' }],
    opts: [
      { label: '受命辅政', flavor: '鞠躬尽瘁，死而后已', fx: [{ t: 'pro', n: 1 }, { t: 'stuck', n: 1 }] },
      { label: '受命揽权', flavor: '挟天子以令群僚', fx: [{ t: 'pro', n: 1 }, { t: 'ban', n: 1 }, { t: 'loseTok' }] },
      { label: '力辞不就', flavor: '逊谢殊恩，急流勇退', fx: [{ t: 'tok', n: 1 }] }
    ]
  },
  101: { text: '党人碑立，名列其间，落职奉祠。', fx: [{ t: 'dem', n: 1 }, { t: 'stuck', n: 1 }] },
  102: { kind: 'coup', name: '黄袍加身', text: '权倾朝野，密结禁军以图废立——成则黄袍加身、南面称孤；败则身首异处、阖门抄斩。成败荣枯，在此一掷！', fx: [{ t: 'coup' }] },
  103: {
    text: '新旧之争复起，调和则犯众怒、独断则结深仇——朝堂之上，你执何议？', fx: [{ t: 'choice' }],
    opts: [
      { label: '锐意调和', flavor: '居中持平，两面周旋', fx: [{ t: 'gamble', win: [{ t: 'pro', n: 1 }], lose: [{ t: 'dem', n: 1 }] }] },
      { label: '结纳外援', flavor: '远交近攻，借势自固', fx: [{ t: 'coin', n: 200 }, { t: 'ret', n: 1 }] },
      { label: '明哲保身', flavor: '缄口结舌，但求无过', fx: [] }
    ]
  },
  105: { text: '册拜太傅，位极人臣之渐。', fx: [{ t: 'pro', n: 1 }] },
  106: {
    text: '飞语中伤，狱吏临门，几陷大狱——生死荣枯，只在你这一念。', fx: [{ t: 'choice' }],
    opts: [
      { label: '倾赀行贿', flavor: '倾家纾难，破财消灾', fx: [{ t: 'coin', n: -300 }] },
      { label: '据理力争', flavor: '抗辞自辩，以白其冤', fx: [{ t: 'gamble', win: [{ t: 'pro', n: 1 }], lose: [{ t: 'ret', n: 2 }] }] },
      { label: '托病乞退', flavor: '称疾乞身，暂避锋芒', fx: [{ t: 'ret', n: 1 }] }
    ]
  },
  107: { text: '新君亲政，尽罢前朝辅弼之臣。', fx: [{ t: 'allDem', n: 1 }] },
  108: { text: '元老硕德，赐剑履上殿，授言事之权。', fx: [{ t: 'tok', n: 1 }] },
  110: { text: '加九锡之议骤起，谤亦随之而至。', fx: [{ t: 'dem', n: 1 }] },
  111: { text: '三登台辅，勋德并隆，天下仰望。', fx: [{ t: 'adv', n: 2 }] },
  112: { text: '黄阁论道，独契圣心，简在帝心。', fx: [{ t: 'pro', n: 1 }] },
  113: { text: '谗者构陷，几致倾覆，赖众正保全。', fx: [{ t: 'ret', n: 1 }] },
  115: { text: '拜太师之渐，群臣交章推毂。', fx: [{ t: 'pro', n: 1 }] },
  116: { text: '末路凶险，政敌作最后一搏。', fx: [{ t: 'ret', n: 2 }] },
  117: { text: '黄阁清风，闲坐品茗，安然一日。', fx: [] },
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
  if (cell.kind === 'coup') return { label: '篡', cls: 'b-coup' };   // 谋反篡位（保留色）
  if (cell.kind === 'rebel') return { label: '谋反', cls: 'b-rebel' };
  const fx = cell.fx;
  if (!fx || !fx.length) return { label: '', cls: 'b-plain' }; // 原位格（留白，不显"原"字）
  const a = fx[0];
  switch (a.t) {
    case 'graft':   return { label: '财', cls: 'b-graft' };   // 贪墨进财（保留色）
    case 'coup':    return { label: '篡', cls: 'b-coup' };
    case 'adv':     return { label: '进' + a.n, cls: 'b-plain' };
    case 'ret':     return { label: '退' + a.n, cls: 'b-plain' };
    case 'pro':     return { label: '升' + a.n, cls: 'b-plain' };
    case 'dem':     return { label: '降' + a.n, cls: 'b-plain' };
    case 'retOff':  return { label: '退职', cls: 'b-plain' };
    case 'nextOff': return { label: '进职', cls: 'b-plain' };
    case 'tok':     return { label: '弹+' + a.n, cls: 'b-tok' };   // 获道具：保留色
    case 'ban':     return { label: '禁+' + a.n, cls: 'b-ban' };   // 获道具：保留色
    case 'dicetok': return { label: '骰', cls: 'b-dice' };          // 获定数骰：保留色
    case 'loseTok': return { label: '失弹', cls: 'b-plain' };
    case 'coin':    return { label: a.n >= 0 ? '财' : '耗', cls: 'b-plain' };
    case 'immune':  return { label: '符', cls: 'b-guard' };
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
    case 'dicetok': return `获定数骰 ×${a.n}（可指定下一掷点数）`;
    case 'loseTok': return '失弹劾令 ×1';
    case 'coin':    return a.n >= 0 ? `获白银 ${a.n} 缗` : `耗去白银 ${-a.n} 缗`;
    case 'immune':  return `得「护身符」×${a.n}（免一次弹劾/禁足）`;
    case 'stuck':   return `困 ${a.n} 回合（停掷）`;
    case 'dingyou': return '困 1 回合，期满起复升 1 品阶';
    case 'allDem':  return `满朝同降 ${a.n} 品阶`;
    case 'rebel':   return '谋反投骰：单数(1/3/5)退回起点得弹劾令，双数(2/4/6)降 3 品阶且困 1 回合';
    case 'gamble':  return '博弈：成则【' + (a.win || []).map(sgtActText).join('、') + '】，败则【' + (a.lose || []).map(sgtActText).join('、') + '】';
    case 'destiny': return '掷天命骰：吉则升品、凶则降品';
    case 'yubi':    return '自择：自升三阶 或 令一对手退后三阶（最低至起点）';
    case 'graft':   return '贪墨求财：或得赃银（至多正五品官价 600 缗），或事泄败露而退一品';
    case 'coup':    return '篡位投骰：6 点登基称帝获胜，4 点退 4 品阶且困 1 回合，余点直贬回起点';
    case 'choice':  return '面临抉择';
    default:        return '';
  }
}
// 整格效果摘要
function sgtFxText(cell) {
  // 抉择格：仅示"须临机决断"与可选项之名，绝不剧透各选项之结果
  if (cell.opts) return '抉择 · 临机决断 — ' + cell.opts.map(o => `「${o.label}」`).join('、') + '（结果须择而后知）';
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
  players.forEach((p, i) => { if (p.seat == null) p.seat = i; });
  SGT = {
    players,            // [{id,name,color,isAI,humanItems,team,pos,tokens,bans,stuck,finished}]
    mode: mode || 'free', // free | team
    turn: 0,
    phase: 'roll',      // roll | resolving | choice | immune | over
    log: [],
    winner: null,
    winnerTeam: null,
    usurp: false,            // 是否以谋反篡位（黄袍加身）取胜
    graftJackpotUsed: false, // 本局贪墨大额横财是否已出（限一次）
    proBudget: 0,       // 本回合连升预算（≤3）
    pendingChain: null, // 待续触发的交互连锁格 {depth}
    choiceDepth: 0,     // 当前抉择格选项效果的连锁深度基线（供续链计深）
    forcedDie: null,    // 定数骰指定的下一掷点数
    busy: false,
    pending: null       // 当前待决输入 {kind, seat}
  };
  return SGT;
}

function sgtSeatPlayer(seat) { return SGT && SGT.players ? SGT.players[seat] : null; }

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
      case 'dicetok': {
        // 定数骰：可指定下一掷点数。独立持有上限 diceHold（2），不占弹劾/禁足之持有栏
        const add = Math.max(0, Math.min(a.n, SGT_SHOP.diceHold - (p.diceItems || 0)));
        p.diceItems = (p.diceItems || 0) + add;
        msgs.push(add > 0 ? `获定数骰 ×${add}（可指定下一掷点数）` : `定数骰已满（${SGT_SHOP.diceHold} 枚），未能入手`);
        break;
      }
      case 'coin': {
        // 获得（n>0）或耗去（n<0）钱财，下限 0。直接增减安全：sgtSyncCoins 仅按品阶差对账，不动此笔
        const before = p.coins;
        p.coins = Math.max(0, p.coins + a.n);
        const d = Math.abs(p.coins - before);
        msgs.push(a.n >= 0 ? `获白银 ${d} 缗` : `耗去白银 ${d} 缗`);
        break;
      }
      case 'immune': {
        // 护身符：可在被对手弹劾/禁足时免除一次。独立持有上限 guardHold（2）
        const add = Math.max(0, Math.min(a.n, SGT_SHOP.guardHold - (p.immune || 0)));
        p.immune = (p.immune || 0) + add;
        msgs.push(add > 0 ? `得「护身符」×${add}（被弹劾或禁足时可免除一次）` : `护身符已满（${SGT_SHOP.guardHold} 枚），未能入手`);
        break;
      }
      case 'stuck': { p.stuck += a.n; msgs.push(`困住 ${a.n} 回合`); break; }
      case 'rebel': {
        // 谋反投骰：单数(1/3/5)沿旧结局——退回起点并得弹劾令；双数(2/4/6)降 3 品阶、困 1 回合、一无所获
        const d = 1 + Math.floor(Math.random() * 6);
        if (d % 2 === 1) {
          p.pos = 0;
          const add = Math.max(0, Math.min(2, SGT_SHOP.holdCap - (p.tokens + p.bans)));
          p.tokens += add;
          msgs.push(`谋反骰得 ${d} 点·单——事泄败露贬归白丁，退回起点，然旧部暗通款曲，得弹劾令牌 ×${add}`);
        } else {
          for (let k = 0; k < 3; k++) p.pos = sgtPrevOffice(p.pos);
          p.stuck += 1;
          msgs.push(`谋反骰得 ${d} 点·双——密谋败露，褫官下狱：降 3 品阶、困 1 回合，一无所获`);
        }
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
      case 'graft': {
        const MAX = SGT_OFFICE_BUY.price(12); // 正五品上官位价 = 600，贪墨横财上限
        // 位置因子 f：品阶越高的进财格 f 越大 → 大额概率更高、可贪之数更巨（#20→低，#49→中，#67→高）
        const f = Math.max(0, Math.min(1, (p.pos - 16) / (74 - 16)));
        const caughtProb = 0.25;
        const bigProb = 0.15 + 0.35 * f;   // 高位贪墨得大额之概率更大
        const r = Math.random();
        if (r < caughtProb) {
          // 被发现（25%）：赃银充公、降一品阶，无所得（财货下限 0）
          p.pos = sgtPrevOffice(p.pos);
          msgs.push('贪墨事泄，为台谏所劾——赃银充公，降一品阶');
        } else if (!SGT.graftJackpotUsed && r < caughtProb + bigProb) {
          // 大额横财（一局仅一次）：上限随位置升高而趋近正五品官价 600
          const bigMax = Math.round(MAX * Math.min(1, 0.6 + 0.5 * f));
          const bigMin = Math.round(bigMax * 0.6);
          const gain = Math.round(bigMin + Math.random() * (bigMax - bigMin));
          p.coins += gain;
          SGT.graftJackpotUsed = true;
          msgs.push(`大肆侵渔，攫赃银 ${gain} 缗入私囊（横财一遇，不可再得）`);
        } else {
          // 小额进财（其余；大额用尽后概率升高）：抬高下限、随位置略增，常得一两百缗（仍不逾横财上限 600）
          const lo = Math.round(100 + 80 * f);   // 下限 100 → 180
          const hi = Math.round(280 + 220 * f);  // 上限 280 → 500
          const gain = Math.round(lo + Math.random() * (hi - lo));
          p.coins += gain;
          msgs.push(`暗通关节，得银 ${gain} 缗`);
        }
        break;
      }
      // yubi / choice / coup 由交互层单独处理，不在此
      default: break;
    }
  }
  return msgs;
}

// 前进/后退落入新格 → 连锁（至多 2 跳）
// 自动格（纯自动效果）就地内联结算；交互格（奇遇·御笔/天命、抉择、谋反篡位）无法在效果结算内同步处理
// （需 UI 抉择 / 特殊回合流程），故挂起 SGT.pendingChain，待本格结算收尾（sgtEndResolution）时续触发。
function sgtMaybeChain(p, msgs, chainDepth) {
  if (chainDepth >= 2) return;            // 至多连锁 2 跳，杜绝长链
  if (p.pos >= SGT_GOAL) return;
  if (SGT.pendingChain) return;           // 已挂起一桩交互连锁，余者留待其后逐一处理
  const cell = SGT_BOARD[p.pos];
  if (!cell.fx || !cell.fx.length) return; // 官职格 / 原地格：无连锁
  const a0 = cell.fx[0];
  const interactive = cell.kind === 'coup' || !!cell.opts || (a0 && (a0.t === 'choice' || a0.t === 'yubi'));
  if (interactive) {
    // 挂起，待 sgtEndResolution 续触发其完整事件流程
    SGT.pendingChain = { depth: chainDepth + 1 };
    msgs.push(`〔连锁〕棋子行至「${cell.name || cell.text.slice(0, 12)}…」，将触发其事件`);
    return;
  }
  // 自动格（事件 / 谋反 / 奇遇·天命等纯自动效果）：就地内联结算
  msgs.push(`〔连锁〕落于「${cell.text}」`);
  msgs.push(...sgtApplyActs(p, cell.fx, chainDepth + 1));
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
  SGT.pendingChain = null;
  SGT.choiceDepth = 0;
  SGT.phase = 'roll';
  SGT.pending = null;
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
    SGT.pending = { kind: 'roll', seat: p.seat };
    sgtRenderControls();
    if (p.humanItems) {
      sgtShowCenter(`<div class="sgt-ev-head">轮到队友 <b style="color:${p.color.css}">${p.name}</b>（托管）——<br>由你决定是否替其使用道具，然后代为掷骰。</div>`);
    }
  } else {
    SGT.busy = true;
    SGT.pending = null;
    setTimeout(() => sgtAiTurn(), SGT_SPEED.aiThink);
  }
}

// ---- 敌意道具施放：弹劾令 / 禁足令，含「护身符」免除判定 ----
function sgtTokenEffect(p, t) {
  t.pos = sgtPrevOffice(t.pos);
  sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 祭出弹劾令牌，参 <b style="color:${t.color.css}">${t.name}</b> 一本——降一品阶，贬至「${SGT_RANKS[sgtOfficeRankAt(t.pos)]}」。`);
  sgtFlash(t.id, 'bad');
}
function sgtBanEffect(p, t) {
  t.stuck += 1;
  sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 祭出禁足令，锁 <b style="color:${t.color.css}">${t.name}</b> 于阙下——下一回合不得掷骰。`);
  sgtFlash(t.id, 'bad');
}

// 护身符免除关卡：目标持有则——真人自决是否免除、AI 自动免除；否则照常施加。cont 为续作回调
function sgtHostileGate(p, t, kind, cont) {
  const nm = kind === 'token' ? '弹劾令' : '禁足令';
  const apply = () => { (kind === 'token' ? sgtTokenEffect : sgtBanEffect)(p, t); sgtRenderAll(); cont(); };
  if ((t.immune || 0) > 0) {
    if (sgtHumanControlled(t)) { sgtPromptImmunity(p, t, kind, apply, cont); return; }
    // AI 持护身符：自动免除一次
    t.immune--;
    sgtLog(`<b style="color:${t.color.css}">${t.name}</b> 祭出「护身符」，化解了 ${p.name} 的${nm}！`);
    sgtFlash(t.id, 'good');
    sgtRenderAll();
    cont();
    return;
  }
  apply();
}

// 真人护身符抉择弹窗（被对手弹劾/禁足时触发）
function sgtPromptImmunity(p, t, kind, apply, cont) {
  const nm = kind === 'token' ? '弹劾令' : '禁足令';
  SGT.busy = true;
  SGT.phase = 'immune';
  SGT.pendingImmune = { t: t, kind: kind, apply: apply, cont: cont };
  SGT.pending = { kind: 'immune', seat: t.seat };
  sgtShowCenter(`<div class="sgt-ev-head">⚔ <b style="color:${p.color.css}">${p.name}</b> 对 <b style="color:${t.color.css}">${t.name}</b> 祭出<b>${nm}</b>！<br>尚有「护身符」×${t.immune}，是否用以免除此令？</div>`);
  sgtRenderControls();
}
function sgtImmuneDecide(use) {
  const pi = SGT.pendingImmune;
  if (!pi) return;
  SGT.pendingImmune = null;
  SGT.pending = null;
  SGT.busy = false;
  SGT.phase = 'roll';
  const nm = pi.kind === 'token' ? '弹劾令' : '禁足令';
  if (use) {
    pi.t.immune--;
    sgtLog(`<b style="color:${pi.t.color.css}">${pi.t.name}</b> 祭出「护身符」，化解了${nm}！`);
    sgtFlash(pi.t.id, 'good');
    sgtRenderAll();
    pi.cont();
  } else {
    sgtLog(`<b style="color:${pi.t.color.css}">${pi.t.name}</b> 留「护身符」以待来日，承受此${nm}。`);
    pi.apply(); // 施加效果，内部续作
  }
}

function sgtResumeRollAfterItem(p) {
  SGT.busy = false;
  SGT.phase = 'roll';
  SGT.pending = { kind: 'roll', seat: p.seat };
  sgtRenderControls();
}

function sgtRenderImmuneButtons() {
  const el = sgtEl('sgtControls');
  const pi = SGT && SGT.pendingImmune;
  if (!el || !pi) return;
  const nm = pi.kind === 'token' ? '弹劾令' : '禁足令';
  el.innerHTML =
    `<button class="brush-btn sgt-choice" onclick="sgtImmuneDecide(true)">用「护身符」免之<small>消去此${nm}，护身符 -1</small></button>`
    + `<button class="brush-btn ghost sgt-choice" onclick="sgtImmuneDecide(false)">受之<small>保留护身符，承受此${nm}</small></button>`;
}

// 弹劾令牌：使目标降一品阶（cont：续作回调；真人点用时默认回操作面板）
function sgtUseToken(targetId, cont) {
  const p = sgtCur();
  const resume = cont || (() => sgtResumeRollAfterItem(p));
  if (p.tokens <= 0) { resume(); return; }
  const t = SGT.players.find(q => q.id === targetId);
  if (!t || t.finished) { resume(); return; }
  if (sgtOfficeRankAt(t.pos) >= 19) { sgtToast('正二品以上位极人臣，弹劾令难撼其位。'); resume(); return; } // 正二品(含)以上免弹劾
  if (t.pos <= 0) { sgtToast('对方已在从九品，无可再降。'); resume(); return; }
  p.tokens--;
  sgtRenderAll();
  sgtHostileGate(p, t, 'token', resume);
}

// 禁足令：使目标下一回合不能掷骰
function sgtUseBan(targetId, cont) {
  const p = sgtCur();
  const resume = cont || (() => sgtResumeRollAfterItem(p));
  if (p.bans <= 0) { resume(); return; }
  const t = SGT.players.find(q => q.id === targetId);
  if (!t || t.finished) { resume(); return; }
  p.bans--;
  sgtRenderAll();
  sgtHostileGate(p, t, 'ban', resume);
}

// 定数骰：开面板择一点数，使下一掷必得此数
function sgtOpenDicePick() {
  const el = sgtEl('sgtControls');
  const p = sgtCur();
  if (!sgtHumanControlled(p) || SGT.busy || SGT.phase !== 'roll') return;
  if ((p.diceItems || 0) <= 0) { sgtToast('手中已无定数骰。'); return; }
  const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  let html = `<div class="sgt-shop-hd">定数骰 · 择一点数，下一掷必得此数（余 ${p.diceItems} 枚）</div>`;
  html += '<div class="sgt-dice-grid">';
  for (let f = 1; f <= 6; f++) {
    html += `<button class="brush-btn ghost sgt-dice-pick" onclick="sgtUseDiceItem(${f})">${faces[f - 1]}<span>${f} 点</span></button>`;
  }
  html += '</div>';
  html += `<button class="brush-btn sgt-choice sgt-hui-btn" onclick="sgtRenderControls()">返回</button>`;
  el.innerHTML = html;
}
function sgtUseDiceItem(face) {
  const p = sgtCur();
  if (!sgtHumanControlled(p) || SGT.busy || SGT.phase !== 'roll') return;
  if ((p.diceItems || 0) <= 0) return;
  face = Math.max(1, Math.min(6, parseInt(face, 10) || 1));
  p.diceItems--;
  SGT.forcedDie = face;
  sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 暗运定数骰，已定下一掷为 <b>${face}</b> 点（余 ${p.diceItems} 枚）。`);
  sgtRenderAll();
  sgtRenderControls();
  sgtToast(`已定下一掷为 ${face} 点，掷骰即得。`);
}

// 随机生成骰面，并执行连点平衡限制：
// 同一人连续 3 次掷中同一点数后，下一次随机掷骰禁止再生成该点数（定数骰指定的点数不受此限）
function sgtRandFace(p) {
  let pool = [1, 2, 3, 4, 5, 6];
  if ((p.faceStreak || 0) >= 3 && p.lastFace) pool = pool.filter(x => x !== p.lastFace);
  return pool[Math.floor(Math.random() * pool.length)];
}
// 登记本次掷得的点数，维护连点计数
function sgtRegisterFace(p, d) {
  if (d === p.lastFace) p.faceStreak = (p.faceStreak || 0) + 1;
  else { p.lastFace = d; p.faceStreak = 1; }
}

// 掷骰
function sgtRoll() {
  if (SGT.busy || SGT.phase !== 'roll') return;
  const p = sgtCur();
  SGT.pending = null;
  SGT.busy = true;
  SGT.phase = 'resolving';
  sgtRenderControls();
  let forced = false, d;
  if (SGT.forcedDie) { d = SGT.forcedDie; SGT.forcedDie = null; forced = true; } // 定数骰指定的点数
  else d = sgtRandFace(p);
  sgtRegisterFace(p, d);
  sgtRenderDice(d, () => {
    const note = forced ? '（定数骰已定）' : ((p.faceStreak >= 3) ? '（已连掷三次此点，下掷将回避）' : '');
    sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 掷得 <b>${d}</b> 点${note}。`);
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
  else if (cell.kind === 'coup') head = `<b style="color:var(--vermilion-2)">谋反 · ${cell.name}！</b>${cell.text}`;
  else head = cell.text;

  // 谋反篡位格：成则直接称帝获胜，败则重挫
  if (cell.kind === 'coup') { sgtResolveCoup(p, cell, head); return; }

  // 需要玩家/AI 抉择的特殊格
  const special = cell.fx[0] && (cell.fx[0].t === 'choice' || cell.fx[0].t === 'yubi');
  if (special) {
    sgtResolveSpecial(p, cell, head);
    return;
  }
  const msgs = sgtApplyActs(p, cell.fx, 0);
  sgtShowEvent(cell, head, msgs);
  sgtRenderAll();
  sgtEndResolution(p);
}

function sgtResolveSpecial(p, cell, head, depth) {
  depth = depth || 0;
  const a = cell.fx[0];
  // 抉择类一律由 AI 自动决断（含真人代管的托管队友——道具之外的抉择仍由 AI 决）
  if (a.t === 'choice') {
    if (p.isAI) {
      const pick = sgtAiChoose(p, cell.opts);
      const msgs = sgtApplyActs(p, cell.opts[pick].fx, depth);
      sgtShowEvent(cell, head + `〔择〕${cell.opts[pick].label}`, msgs);
      sgtRenderAll();
      sgtEndResolution(p);
    } else {
      SGT.choiceDepth = depth; // 真人抉择：记下连锁深度，待 sgtChoicePicked 续计
      SGT.phase = 'choice';
      SGT.pending = { kind: 'choice', seat: p.seat };
      sgtShowEvent(cell, head, null);
      sgtRenderControls();
    }
  } else if (a.t === 'yubi') {
    if (p.isAI) {
      // 有领先于己的对手则压其退三阶，否则自升三阶
      const ahead = sgtPlayersAheadOf(p).filter(q => q.pos > 0);
      if (ahead.length) {
        const tgt = ahead.sort((x, y) => y.pos - x.pos)[0];
        sgtApplyYubiPush(tgt.id);
        sgtShowEvent(cell, head, [`御笔朱圈——令 <b>${tgt.name}</b> 退后三阶`]);
      } else {
        sgtApplyYubiSelf(p);
        sgtShowEvent(cell, head, ['御笔朱圈——自升三阶']);
      }
      sgtRenderAll(); sgtEndResolution(p);
    } else {
      SGT.phase = 'choice';
      SGT.pending = { kind: 'yubi', seat: p.seat };
      sgtShowEvent(cell, head, null);
      sgtRenderControls();
    }
  }
}

// 御笔：自升三阶（连升上限内）
function sgtApplyYubiSelf(p) {
  let n = 3; if (SGT.proBudget + n > 3) n = 3 - SGT.proBudget;
  for (let k = 0; k < n; k++) p.pos = sgtNextOffice(p.pos);
  SGT.proBudget += n;
}
// 御笔：令一对手退后三阶（最低至起点）
function sgtApplyYubiPush(targetId) {
  const t = SGT.players.find(q => q.id === targetId);
  if (!t) return;
  for (let k = 0; k < 3; k++) t.pos = sgtPrevOffice(t.pos); // sgtPrevOffice 下限为 0（起点）
  sgtFlash(t.id, 'bad');
}
// 玩家完成抉择后调用
function sgtChoicePicked(idx) {
  const p = sgtCur();
  SGT.pending = null;
  const cell = SGT_BOARD[p.pos];
  const depth = SGT.choiceDepth || 0;
  SGT.choiceDepth = 0;
  const msgs = sgtApplyActs(p, cell.opts[idx].fx, depth);
  sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 择「${cell.opts[idx].label}」：${msgs.join('，') || '无事'}。`);
  sgtShowEvent(cell, `${cell.text}〔择〕${cell.opts[idx].label}`, msgs);
  sgtRenderAll();
  sgtEndResolution(p);
}
function sgtYubiSelf() {
  const p = sgtCur();
  SGT.pending = null;
  sgtApplyYubiSelf(p);
  sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 奉御笔，自升三阶。`);
  sgtRenderAll();
  sgtEndResolution(p);
}
function sgtYubiPush(targetId) {
  const p = sgtCur();
  SGT.pending = null;
  const t = SGT.players.find(q => q.id === targetId);
  if (!t) return;
  sgtApplyYubiPush(targetId);
  sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 奉御笔，令 <b style="color:${t.color.css}">${t.name}</b> 退后三阶。`);
  sgtRenderAll();
  sgtEndResolution(p);
}
// 结算尾声：先续触发挂起的交互连锁；否则检查胜负 / 进入下一回合
function sgtEndResolution(p) {
  // 交互格连锁：上一步效果把棋子带入了奇遇/抉择/谋反篡位格 —— 在此续触发其完整事件
  if (SGT.pendingChain && !p.finished && p.pos < SGT_GOAL) {
    const depth = SGT.pendingChain.depth;
    SGT.pendingChain = null;
    SGT.busy = true;
    SGT.phase = 'resolving';
    setTimeout(() => sgtResolveChainLanding(p, depth), p.isAI ? 1400 : 1100);
    return;
  }
  SGT.busy = false;
  if (p.pos >= SGT_GOAL) { sgtWin(p); return; }
  SGT.phase = 'roll';
  setTimeout(() => sgtAdvanceTurn(), p.isAI ? SGT_SPEED.aiEvent : SGT_SPEED.humanEvent);
}

// 续触发连锁格：镜像 sgtResolveLanding，但读取当前所在格、并把连锁深度透传给后续效果
function sgtResolveChainLanding(p, depth) {
  SGT.busy = true;
  if (p.pos >= SGT_GOAL) { sgtWin(p); return; }
  const cell = SGT_BOARD[p.pos];
  let head = '〔连锁〕';
  if (cell.kind === 'office' || cell.kind === 'start') head += `履新 <b>${cell.name}</b>。`;
  else if (cell.kind === 'fortune') head += `奇遇 · <b>${cell.name}</b>：${cell.text}`;
  else if (cell.kind === 'rebel') head += `<b style="color:var(--vermilion-2)">谋反！</b>${cell.text}`;
  else if (cell.kind === 'coup') head += `<b style="color:var(--vermilion-2)">谋反 · ${cell.name}！</b>${cell.text}`;
  else head += cell.text;
  // 谋反篡位格
  if (cell.kind === 'coup') { sgtResolveCoup(p, cell, head); return; }
  // 抉择 / 御笔
  const special = cell.fx[0] && (cell.fx[0].t === 'choice' || cell.fx[0].t === 'yubi');
  if (special) { sgtResolveSpecial(p, cell, head, depth); return; }
  // 自动格（兜底；正常情况下自动格已在 sgtMaybeChain 内联结算，不会走到这里）
  const msgs = sgtApplyActs(p, cell.fx, depth);
  sgtShowEvent(cell, head, msgs);
  sgtRenderAll();
  sgtEndResolution(p);
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
  sgtShowVictory(p, false);
}

// 谋反篡位格结算：低概率直接称帝胜出，败则降阶并困
function sgtResolveCoup(p, cell, head) {
  const d = 1 + Math.floor(Math.random() * 6);
  if (d === SGT_COUP.winFace) {
    // 投得 6 点：篡位功成，登基称帝直接获胜
    sgtShowEvent(cell, head, [`篡位骰得 ${d} 点！🐉 禁军拥戴，黄袍加身，南面称孤——登 基 称 帝！`]);
    sgtRenderAll();
    sgtUsurp(p);
  } else if (d === SGT_COUP.demFace) {
    // 投得 4 点：事败被擒，退 4 品阶、困 1 回合，一无所获
    for (let k = 0; k < SGT_COUP.demSteps; k++) p.pos = sgtPrevOffice(p.pos);
    p.stuck += 1;
    sgtShowEvent(cell, head, [`篡位骰得 ${d} 点·凶——事败被擒、褫官下狱：退 ${SGT_COUP.demSteps} 品阶、困 1 回合，一无所获`]);
    sgtRenderAll();
    sgtEndResolution(p);
  } else {
    // 其余点(1/2/3/5)：谋泄势孤，褫夺官身、贬为白丁，此局直贬回起点
    p.pos = 0;
    sgtShowEvent(cell, head, [`篡位骰得 ${d} 点·败——谋泄势孤，褫夺官身、贬为白丁，直贬回起点，仕途从头来过`]);
    sgtRenderAll();
    sgtEndResolution(p);
  }
}

// 篡位称帝胜利（区别于常规登顶）
function sgtUsurp(p) {
  p.finished = true;
  p.pos = SGT_GOAL;
  SGT.winner = p;
  SGT.winnerTeam = p.team;
  SGT.usurp = true;
  SGT.phase = 'over';
  SGT.busy = false;
  if (SGT.mode === 'team') sgtTeammates(p).forEach(q => { q.finished = true; });
  sgtRenderAll();
  const teamTxt = SGT.mode === 'team' ? `（${SGT_TEAM_NAME[p.team]}队）` : '';
  sgtLog(`👑 <b style="color:${p.color.css}">${p.name}</b>${teamTxt} 谋反功成，黄袍加身，登基称帝——改元易号，君临天下！对局终了！`);
  sgtShowVictory(p, true);
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
  // 0a. 捐纳买官（v2.0）：钱财够则向可捐之官中择最高可负担者捐升（至少直升 2 阶才划算）
  const curRank0 = sgtOfficeRankAt(p.pos);
  const aff = SGT_OFFICE_BUY.ranks.filter(r => r > curRank0 && p.coins >= SGT_OFFICE_BUY.price(r));
  if (aff.length) {
    const buy = aff[aff.length - 1]; // 最高可负担之官
    if (buy >= curRank0 + 2) {
      p.coins -= SGT_OFFICE_BUY.price(buy);
      p.pos = SGT_OFFICE_BY_RANK[buy];
      p.rank = buy;
      used = true;
      sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 纳赀捐官，径授「${SGT_RANKS[buy]}」（余 ${p.coins} 缗）。`);
    }
  }
  // 0. 进商肆补货：钱够、持有未满则买（单局购买不限，仅受持有上限约束；优先弹劾令）
  while ((p.tokens + p.bans) < SGT_SHOP.holdCap) {
    if (p.coins >= SGT_SHOP.tokPrice) {
      p.coins -= SGT_SHOP.tokPrice; p.boughtTok++; p.tokens++; used = true;
      sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 入商肆购弹劾令（余 ${p.coins} 缗）。`);
    } else if (p.coins >= SGT_SHOP.banPrice) {
      p.coins -= SGT_SHOP.banPrice; p.boughtBan++; p.bans++; used = true;
      sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 入商肆购禁足令（余 ${p.coins} 缗）。`);
    } else break;
  }
  // 1+2. 敌意道具（弹劾令→禁足令）：逐一施放；若目标为真人且持护身符会弹窗等待其抉择，故以续作串接
  const tryBan = (next) => {
    if (p.bans > 0) { const t = sgtAiPickTarget(p, false); if (t) { used = true; sgtUseBan(t.id, next); return; } }
    next();
  };
  const tryToken = (next) => {
    if (p.tokens > 0) { const t = sgtAiPickTarget(p, true); if (t) { used = true; sgtUseToken(t.id, next); return; } }
    next();
  };
  tryToken(() => tryBan(() => {
    // 3. 掷骰
    SGT.busy = false;
    setTimeout(() => sgtRoll(), used ? SGT_SPEED.aiItemHold : 500);
  }));
}
function sgtAiPickTarget(p, forImpeach) {
  let opp = sgtOpponents(p).filter(q => q.pos > 0);
  if (forImpeach) opp = opp.filter(q => sgtOfficeRankAt(q.pos) < 19); // 弹劾令对正二品(含)以上无效
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
      else if (a.t === 'coin') s += a.n / 100;        // 钱财折算（300 缗≈3 分）
      else if (a.t === 'immune') s += a.n * 3;         // 护身符：防御价值
      else if (a.t === 'stuck') s -= a.n * 3;
      else if (a.t === 'gamble') {                     // 博弈：取成败均值的折算
        const ev = fx => (fx || []).reduce((t, x) => t + score([x]), 0);
        s += 0.5 * (ev(a.win) + ev(a.lose));
      }
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

// 迷宫廊道：逐格只描「外墙」——朝盘外（远离盘心）那一侧、且非行进方向之边。
// 每条环道分界只由内侧一格描其外墙，故全盘墙体单层不重叠、粗细一致；
// 朝「上一格/下一格」的边留空，廊道由此连通、换环处自留开口，整路自 #0 盘旋直通 #119。
function sgtCellWalls(i) {
  const [r, c] = SGT_COORDS[i];
  const prev = i > 0 ? SGT_COORDS[i - 1] : null;
  const next = i < SGT_N - 1 ? SGT_COORDS[i + 1] : null;
  const cr = (SGT_GRID_ROWS - 1) / 2, cc = (SGT_GRID_COLS - 1) / 2; // 盘心 (5,7)
  const isTravel = (nr, nc) =>
    (prev && prev[0] === nr && prev[1] === nc) || (next && next[0] === nr && next[1] === nc);
  const walls = [];
  if (r <= cr && !isTravel(r - 1, c)) walls.push('w-t'); // 上半盘 → 上为外
  if (r >= cr && !isTravel(r + 1, c)) walls.push('w-b'); // 下半盘 → 下为外
  if (c <= cc && !isTravel(r, c - 1)) walls.push('w-l'); // 左半盘 → 左为外
  if (c >= cc && !isTravel(r, c + 1)) walls.push('w-r'); // 右半盘 → 右为外
  return walls;
}

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
    d.classList.add(...sgtCellWalls(i)); // 迷宫廊道·外墙
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
      if (cell.kind === 'coup') d.classList.add('sgt-coup');
      const b = sgtFxBadge(cell);
      d.innerHTML = `<span class="sgt-c-badge ${b.cls}">${b.label}</span>`;
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
    if (p.diceItems > 0) meta.push('骰' + p.diceItems);
    if (p.immune > 0) meta.push('符' + p.immune);
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
  if (sgtGuide) {
    let html = '';
    if (p.tokens > 0) html += `<button class="brush-btn ghost sgt-tok-btn" onclick="sgtOpenImpeach()">用弹劾令（×${p.tokens}）<small>使一名对手降一品阶</small></button>`;
    if (p.bans > 0)   html += `<button class="brush-btn ghost sgt-tok-btn" onclick="sgtOpenBan()">用禁足令（×${p.bans}）<small>使一名对手停掷一回合</small></button>`;
    if ((p.diceItems || 0) > 0) html += `<button class="brush-btn ghost sgt-tok-btn" onclick="sgtOpenDicePick()">用定数骰（×${p.diceItems}）<small>指定下一掷点数</small></button>`;
    html += `<button class="brush-btn ghost sgt-tok-btn" onclick="sgtOpenShop()">进 商 肆（${p.coins} 缗）<small>购弹劾令 / 禁足令 / 定数骰 / 护身符</small></button>`;
    html += '<button class="brush-btn">掷 骰 子</button>';
    el.innerHTML = html;
    return;
  }
  if (SGT.phase === 'over') {
    el.innerHTML = `<button class="brush-btn" onclick="sgtRestart()">再 开 一 局</button>`;
    return;
  }
  const pend = SGT.pending;
  if (SGT.phase === 'choice') {
    if (pend && pend.kind === 'choice') return sgtRenderChoiceButtons(SGT_BOARD[p.pos], p);
    if (pend && pend.kind === 'yubi') return sgtRenderYubiButtons(SGT_BOARD[p.pos], p);
    return;
  }
  if (SGT.phase === 'immune') {
    return sgtRenderImmuneButtons();
  }
  if (!sgtHumanControlled(p) || SGT.busy || SGT.phase !== 'roll') {
    const waitName = pend ? (sgtSeatPlayer(pend.seat) || p).name : p.name;
    el.innerHTML = `<div class="sgt-wait">${SGT.busy ? '· 推演中 ·' : '· 待 ' + waitName + ' 行棋 ·'}</div>`;
    return;
  }
  let html = '';
  if (p.tokens > 0) html += `<button class="brush-btn ghost sgt-tok-btn" onclick="sgtOpenImpeach()">用弹劾令（×${p.tokens}）<small>使一名对手降一品阶</small></button>`;
  if (p.bans > 0)   html += `<button class="brush-btn ghost sgt-tok-btn" onclick="sgtOpenBan()">用禁足令（×${p.bans}）<small>使一名对手停掷一回合</small></button>`;
  if ((p.diceItems || 0) > 0) html += `<button class="brush-btn ghost sgt-tok-btn" onclick="sgtOpenDicePick()">用定数骰（×${p.diceItems}）<small>指定下一掷点数</small></button>`;
  html += `<button class="brush-btn ghost sgt-tok-btn" onclick="sgtOpenShop()">进 商 肆（${p.coins} 缗）<small>购弹劾令 / 禁足令 / 定数骰 / 护身符</small></button>`;
  const rollLabel = p.humanItems ? '代 队 友 掷 骰' : '掷 骰 子';
  html += `<button class="brush-btn" onclick="sgtRoll()">${rollLabel}</button>`;
  el.innerHTML = html;
}

// 骰子动画
function sgtRenderDice(final, done) {
  const stage = sgtEl('sgtDiceStage');
  const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  sgtPlayDiceSfx(); // 掷骰音效
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
  sgtMirrorEcho(html, true); // 手机端：同文镜像到棋盘下方的可读事件面板（前缀当前玩家信息）
}
// 把中央事件文字镜像到独立面板（手机端棋盘中央区太小、长文会被裁切），并在前面标明"哪个玩家 / 什么品阶"
function sgtMirrorEcho(html, flash) {
  const echo = sgtEl('sgtEventEcho');
  if (!echo) return;
  let who = '';
  if (html && SGT && SGT.players) {
    const p = sgtCur();
    if (p) {
      const rank = sgtOfficeRankAt(p.pos);
      const teamTag = (SGT.mode === 'team') ? `<span class="sgt-team-tag team-${p.team}">${SGT_TEAM_NAME[p.team]}</span>` : '';
      who = `<div class="sgt-echo-who"><span class="sgt-dot" style="background:${p.color.css}">${p.color.glyph}</span>`
        + `${teamTag}<b style="color:${p.color.css}">${p.name}</b>`
        + `<span class="sgt-echo-rank robe-txt-${sgtRobe(rank)}">${SGT_RANKS[rank]}</span></div>`;
    }
  }
  echo.innerHTML = who + (html || '<span class="sgt-echo-empty">— 掷骰后，本格事件描述将在此完整显示 —</span>');
  if (flash !== false) {
    echo.classList.remove('flash'); void echo.offsetWidth; echo.classList.add('flash');
  }
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

// 抉择按钮（仅示选项之名与意态，不显示其结果——择而后知）
function sgtRenderChoiceButtons(cell, p) {
  const el = sgtEl('sgtControls');
  el.innerHTML = cell.opts.map((o, i) =>
    `<button class="brush-btn sgt-choice" onclick="sgtChoicePicked(${i})">${o.label}<small>${o.flavor || ''}</small></button>`
  ).join('');
}
function sgtRenderYubiButtons(cell, p) {
  const el = sgtEl('sgtControls');
  let html = `<button class="brush-btn sgt-choice" onclick="sgtYubiSelf()">自升三阶<small>跳至前方第三官职格</small></button>`;
  const opp = sgtOpponents(p).filter(q => q.pos > 0);
  html += opp.map(q =>
    `<button class="brush-btn ghost sgt-choice" onclick="sgtYubiPush('${q.id}')">令 <span style="color:${q.color.css}">${q.name}</span> 退三阶<small>退后三个官职格（最低至起点）</small></button>`
  ).join('');
  if (!opp.length) html += `<div class="sgt-shop-note">众皆在起点，无可压制——唯自升三阶。</div>`;
  el.innerHTML = html;
}

// 弹劾选择面板
function sgtOpenImpeach() {
  const el = sgtEl('sgtControls');
  const p = sgtCur();
  const targets = sgtOpponents(p).filter(q => q.pos > 0 && sgtOfficeRankAt(q.pos) < 19); // 正二品(含)以上免弹劾
  if (!targets.length) { sgtToast('无可弹劾之人（正二品以上免弹劾）。'); return; }
  el.innerHTML = targets.map(q =>
    `<button class="brush-btn ghost sgt-choice" onclick="sgtUseToken('${q.id}')">
       参 <span style="color:${q.color.css}">${q.name}</span> 一本<small>使其降一品阶</small></button>`
  ).join('') + `<button class="brush-btn sgt-choice sgt-hui-btn" onclick="sgtRenderControls()">返回</button>`;
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
  ).join('') + `<button class="brush-btn sgt-choice sgt-hui-btn" onclick="sgtRenderControls()">返回</button>`;
}

// 商肆面板（v1.2）
function sgtOpenShop() {
  const el = sgtEl('sgtControls');
  const p = sgtCur();
  const held = p.tokens + p.bans;
  const mk = (kind, label, price) => {
    const bought = kind === 'tok' ? p.boughtTok : p.boughtBan;
    const reasons = [];
    if (held >= SGT_SHOP.holdCap) reasons.push('持有已满（3 件）');
    if (p.coins < price) reasons.push('钱财不足');
    const dis = reasons.length > 0;
    return `<button class="brush-btn ghost sgt-choice" ${dis ? 'disabled' : ''} onclick="sgtBuyItem('${kind}')">
      购 ${label}（${price} 缗）<small>${dis ? reasons[0] : `立即入手（本局已购 ${bought}，购买不限）`}</small></button>`;
  };
  // 捐纳买官（v2.0）：仅数个指定官阶可捐（从八品/从七品上/从六品上/从五品上/从四品），直升对应官阶
  const curRank = sgtOfficeRankAt(p.pos);
  const buyables = SGT_OFFICE_BUY.ranks.filter(r => r > curRank);
  let officeHtml = '';
  if (!buyables.length) {
    officeHtml = `<div class="sgt-shop-note">已逾可捐之最高官（从四品），捐纳之门已闭——此后唯凭政绩与天命。</div>`;
  } else {
    officeHtml = buyables.map(r => {
      const price = SGT_OFFICE_BUY.price(r);
      const dis = p.coins < price;
      return `<button class="brush-btn ghost sgt-choice sgt-buy-office" ${dis ? 'disabled' : ''} onclick="sgtBuyOffice(${r})">
        捐 ${sgtRankTier(r)}·${sgtRankOffice(r)}（${price} 缗）<small>${dis ? '钱财不足' : '径授此官·直升其阶'}</small></button>`;
    }).join('');
  }
  // 定数骰：独立持有上限（diceHold），单局购买不限
  const diceReasons = [];
  if ((p.diceItems || 0) >= SGT_SHOP.diceHold) diceReasons.push(`持有已满（${SGT_SHOP.diceHold} 枚）`);
  if (p.coins < SGT_SHOP.dicePrice) diceReasons.push('钱财不足');
  const diceDis = diceReasons.length > 0;
  const diceHtml = `<button class="brush-btn ghost sgt-choice" ${diceDis ? 'disabled' : ''} onclick="sgtBuyItem('dice')">
      购 定数骰（${SGT_SHOP.dicePrice} 缗）<small>${diceDis ? diceReasons[0] : `可指定下一掷点数（本局已购 ${p.boughtDice || 0}，购买不限，持 ${p.diceItems || 0}/${SGT_SHOP.diceHold}）`}</small></button>`;
  // 护身符：独立持有上限（guardHold），单局购买不限
  const guardReasons = [];
  if ((p.immune || 0) >= SGT_SHOP.guardHold) guardReasons.push(`持有已满（${SGT_SHOP.guardHold} 枚）`);
  if (p.coins < SGT_SHOP.guardPrice) guardReasons.push('钱财不足');
  const guardDis = guardReasons.length > 0;
  const guardHtml = `<button class="brush-btn ghost sgt-choice" ${guardDis ? 'disabled' : ''} onclick="sgtBuyItem('guard')">
      购 护身符（${SGT_SHOP.guardPrice} 缗）<small>${guardDis ? guardReasons[0] : `可免一次弹劾/禁足（本局已购 ${p.boughtGuard || 0}，购买不限，持 ${p.immune || 0}/${SGT_SHOP.guardHold}）`}</small></button>`;
  el.innerHTML =
    `<div class="sgt-shop-hd">商肆 · 现银 <b>${p.coins}</b> 缗　持有 ${held}/${SGT_SHOP.holdCap}（弹劾/禁足共此栏）　骰 ${p.diceItems || 0}/${SGT_SHOP.diceHold}　符 ${p.immune || 0}/${SGT_SHOP.guardHold}　购买不限</div>`
    + mk('tok', '弹劾令', SGT_SHOP.tokPrice)
    + mk('ban', '禁足令', SGT_SHOP.banPrice)
    + diceHtml
    + guardHtml
    + `<div class="sgt-shop-hd sgt-shop-sub">捐 纳 买 官 · 正四品以下可捐，直升其阶</div>`
    + officeHtml
    + `<button class="brush-btn sgt-choice sgt-hui-btn" onclick="sgtRenderControls()">返回</button>`;
}
// 捐纳买官：扣价并径直锚定到对应官职格（不另发升官俸）
function sgtBuyOffice(rank) {
  const p = sgtCur();
  if (!sgtHumanControlled(p) || SGT.busy || SGT.phase !== 'roll') return;
  const curRank = sgtOfficeRankAt(p.pos);
  if (!SGT_OFFICE_BUY.ranks.includes(rank)) { sgtToast('此官不在可捐之列。'); return; }
  if (rank <= curRank) return;
  const price = SGT_OFFICE_BUY.price(rank);
  if (p.coins < price) { sgtToast(`捐此官需 ${price} 缗（现有 ${p.coins} 缗）。`); return; }
  const idx = SGT_OFFICE_BY_RANK[rank];
  if (idx == null) return;
  p.coins -= price;
  p.pos = idx;
  p.rank = rank; // 锚定品阶：使 sgtSyncCoins 无品阶差，避免买官又领升官俸
  sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 纳赀捐官，径授「${SGT_RANKS[rank]}」（耗 ${price} 缗，余 ${p.coins} 缗）。`);
  sgtFlash(p.id, 'good');
  sgtRenderAll();
  sgtOpenShop();
}
function sgtBuyItem(kind) {
  const p = sgtCur();
  if (!sgtHumanControlled(p) || SGT.busy || SGT.phase !== 'roll') return;
  if (kind === 'dice') {
    if ((p.diceItems || 0) >= SGT_SHOP.diceHold) { sgtToast(`定数骰持有已满（${SGT_SHOP.diceHold} 枚），用掉再买。`); return; }
    if (p.coins < SGT_SHOP.dicePrice) { sgtToast(`钱财不足，需 ${SGT_SHOP.dicePrice} 缗（现有 ${p.coins} 缗）。`); return; }
    p.coins -= SGT_SHOP.dicePrice; p.diceItems = (p.diceItems || 0) + 1; p.boughtDice = (p.boughtDice || 0) + 1;
    sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 入商肆，购得定数骰一枚（耗 ${SGT_SHOP.dicePrice} 缗，余 ${p.coins} 缗）。`);
    sgtRenderAll();
    sgtOpenShop();
    return;
  }
  if (kind === 'guard') {
    if ((p.immune || 0) >= SGT_SHOP.guardHold) { sgtToast(`护身符持有已满（${SGT_SHOP.guardHold} 枚），用掉再买。`); return; }
    if (p.coins < SGT_SHOP.guardPrice) { sgtToast(`钱财不足，需 ${SGT_SHOP.guardPrice} 缗（现有 ${p.coins} 缗）。`); return; }
    p.coins -= SGT_SHOP.guardPrice; p.immune = (p.immune || 0) + 1; p.boughtGuard = (p.boughtGuard || 0) + 1;
    sgtLog(`<b style="color:${p.color.css}">${p.name}</b> 入商肆，购得护身符一枚（耗 ${SGT_SHOP.guardPrice} 缗，余 ${p.coins} 缗）。`);
    sgtRenderAll();
    sgtOpenShop();
    return;
  }
  const price = kind === 'tok' ? SGT_SHOP.tokPrice : SGT_SHOP.banPrice;
  const nm = kind === 'tok' ? '弹劾令' : '禁足令';
  if (p.tokens + p.bans >= SGT_SHOP.holdCap) { sgtToast('持有道具已满（3 件），用掉再买。'); return; }
  if (p.coins < price) { sgtToast(`钱财不足，需 ${price} 缗（现有 ${p.coins} 缗）。`); return; }
  p.coins -= price;
  if (kind === 'tok') { p.tokens++; p.boughtTok++; } else { p.bans++; p.boughtBan++; }
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
    else if (cell.kind === 'coup') s += `<b>谋反篡位 · ${cell.name}</b>：${cell.text}`;
    else s += cell.text;
    s += `　<span class="sgt-toast-fx">【效果：${sgtFxText(cell)}】</span>`;
  }
  sgtToast(s, 4500);
}

// 胜利浮层（usurp=true 为谋反篡位·登基称帝结算页）
function sgtShowVictory(p, usurp) {
  const ov = sgtEl('sgtVictory');
  ov.classList.toggle('usurp', !!usurp);
  const seal = sgtEl('sgtVicSeal'), title = sgtEl('sgtVicTitle'), sub = sgtEl('sgtVicSub');
  if (usurp) {
    if (seal) seal.textContent = '帝';
    if (title) title.textContent = '黄 袍 加 身';
    if (sub) sub.textContent = '谋反功成 · 篡位称帝 · 君临天下';
  } else {
    if (seal) seal.textContent = '太师';
    if (title) title.textContent = '位 极 人 臣';
    if (sub) sub.textContent = '竞登正一品 · 仕途圆满';
  }
  sgtEl('sgtVicName').innerHTML = SGT.mode === 'team'
    ? `${SGT_TEAM_NAME[p.team]}队　<span style="color:${p.color.css}">${p.name}</span> 等`
    : `<span style="color:${p.color.css}">${p.name}</span>`;
  const rankList = SGT.players.slice().sort((a, b) => b.pos - a.pos);
  sgtEl('sgtVicList').innerHTML = rankList.map((q, i) => {
    const teamTag = SGT.mode === 'team' ? `<span class="sgt-team-tag team-${q.team}">${SGT_TEAM_NAME[q.team]}</span>` : '';
    // 篡位称帝者列于第一甲，品阶栏书「皇帝」而非正一品
    const tier = (usurp && q === p) ? '皇帝' : sgtRankTier(sgtOfficeRankAt(q.pos));
    return `<div class="sgt-vic-row"><span>${['第一甲', '第二甲', '第三甲', '第四甲'][i]}</span>
     <span>${teamTag}<span style="color:${q.color.css}">${q.name}</span></span>
     <span>${tier}</span></div>`;
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
    const base = () => ({ pos: 0, tokens: 0, bans: 0, stuck: 0, coins: 0, boughtTok: 0, boughtBan: 0, diceItems: 0, boughtDice: 0, lastFace: 0, faceStreak: 0, rank: 0, immune: 0, boughtGuard: 0, finished: false });
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
        pos: 0, tokens: 0, bans: 0, stuck: 0, coins: 0, boughtTok: 0, boughtBan: 0, diceItems: 0, boughtDice: 0, lastFace: 0, faceStreak: 0, rank: 0, immune: 0, boughtGuard: 0, finished: false
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
  if (sgtGuide) { sgtReturnSetupFromGuide(); return; }
  sgtCloseVictory();
  sgtEl('sgtPlay').classList.add('hidden');
  sgtEl('sgtSetup').classList.remove('hidden');
  SGT = null;
}

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

function sgtShowPlay() {
  sgtEl('sgtSetup').classList.add('hidden');
  sgtEl('sgtPlay').classList.remove('hidden');
}

const SGT_GUIDE_STEPS = [
  {
    title: '起始格',
    body: '所有玩家都从左上角的起始官职格出发，自从九品小官开始走完整条仕途。',
    shortBody: '从左上角起步，自从九品开始升官。',
    focusCells: [0],
    playerPos: 0,
    center: '<b>起始格</b>：从九品·太常寺奉礼郎。这里是每局开端。'
  },
  {
    title: '终点格',
    body: '棋盘最后一格是正一品·太师。自由对战中，谁先到这里谁获胜；组队模式中，一名队友到达即可全队同胜。',
    shortBody: '先到终点正一品·太师者获胜。',
    focusCells: [119],
    playerPos: 116,
    center: '<b>终点格</b>：正一品·太师。先至者位极人臣。'
  },
  {
    title: '官职格与章服',
    body: '带完整官名的格子是官职格，会锚定当前品阶。绿袍、绯袍、紫袍代表不同阶段，越往后官位越高。',
    shortBody: '官职格决定品阶，绿、绯、紫越走越高。',
    focusCells: [5, 40, 74, 119],
    playerPos: 40,
    samples: ['升 N 品阶会跳到后面的官职格。', '降 N 品阶会退到前面的官职格。']
  },
  {
    title: '事件格',
    body: '普通事件格会让你前进、后退、升官、降官、困住或原地停留。短标只提示大概效果，具体内容以中央事件为准。',
    shortBody: '事件格会前进、后退、升降官或困住。',
    focusCells: [2, 55, 83, 116],
    playerPos: 55,
    samples: ['进/退：移动格数。', '升/降：改变品阶。', '困：下一回合停掷。']
  },
  {
    title: '奇遇与抉择',
    body: '金色奇遇格和“择”字格会触发特殊选择。有些选择不直接剧透结果，需要临机决断。',
    shortBody: '奇遇和抉择会带来特殊机会或风险。',
    focusCells: [15, 44, 90, 100],
    playerPos: 90,
    samples: ['御笔亲批：可自升或令对手后退。', '紫微星动：投天命骰判吉凶。', '贵人相助：荐拔、馈赠或求护身符。']
  },
  {
    title: '道具格',
    body: '棋盘上会散布道具格。弹劾令、禁足令、定数骰和护身符会改变对局节奏。',
    shortBody: '道具能进攻、防守或指定骰点。',
    focusCells: [17, 25, 32, 39, 95],
    playerPos: 32,
    samples: ['弹劾令：对手降一品阶。', '禁足令：停掷一回合。', '定数骰：指定下一掷。', '护身符：抵免弹劾/禁足。']
  },
  {
    title: '操作区与商肆',
    body: '轮到你时，右侧操作区会显示掷骰、使用道具和进入商肆。钱财足够时，可在商肆购买道具或捐纳买官。',
    shortBody: '轮到你时，在操作区掷骰、用道具或进商肆。',
    focusPanel: 'controls',
    playerPos: 58,
    samples: ['进商肆：购买弹劾令、禁足令、定数骰、护身符。', '捐纳买官：正四品以下若钱财足够，可直升指定官阶。']
  },
  {
    title: '棋盘中央事件',
    body: '掷骰落格后，棋盘中央会显示本格事件和结算结果。手机端还会在下方“当前事件”面板镜像完整文字。',
    shortBody: '落格后的事件说明会显示在这里；手机端看下方事件区。',
    focusPanel: 'center',
    playerPos: 62,
    center: '<b>示例事件</b>：朝议新法，慷慨陈词，四座动容。<div class="sgt-ev-msgs">前进 2 格，获得弹劾令 ×1</div>'
  },
  {
    title: '仕途榜',
    body: '仕途榜显示所有玩家的当前位置、官阶、钱财和持有道具。',
    shortBody: '仕途榜查看排名、官阶、钱财和道具。',
    focusPanel: 'standings',
    playerPos: 68,
    samples: ['令/禁/骰/符分别代表四类道具。', '困表示该玩家还有停掷回合。']
  },
  {
    title: '邸报',
    body: '邸报记录整局关键动作：掷骰、升降、道具使用、暂离托管和胜负结果。看不清上一回合发生了什么，就看这里。',
    shortBody: '邸报记录掷骰、升降、道具和托管。',
    focusPanel: 'log',
    playerPos: 74,
    samples: ['邸报可用于回看上一回合的关键行动与结算结果。']
  }
];
let sgtGuide = null;
let sgtGuideKeyBound = false;

function sgtGuideClearFocus() {
  document.querySelectorAll('.sgt-guide-focus-cell').forEach(e => e.classList.remove('sgt-guide-focus-cell'));
  document.querySelectorAll('.sgt-guide-focus-panel').forEach(e => e.classList.remove('sgt-guide-focus-panel'));
}
function sgtGuidePanel(key) {
  if (key === 'center') return sgtEl('sgtGrid') && sgtEl('sgtGrid').querySelector('.sgt-center');
  if (key === 'controls') return sgtEl('sgtControls') && sgtEl('sgtControls').closest('.sgt-panel');
  if (key === 'standings') return sgtEl('sgtStandings') && sgtEl('sgtStandings').closest('.sgt-panel');
  if (key === 'log') return sgtEl('sgtLog') && sgtEl('sgtLog').closest('.sgt-panel');
  return null;
}
function sgtGuideNavHtml(i) {
  const last = SGT_GUIDE_STEPS.length - 1;
  const prev = i > 0
    ? `<button class="sgt-guide-arrow sgt-guide-prev" onclick="sgtGuidePrev()" aria-label="上一步"><span>←</span><em>上一步</em></button>`
    : '';
  const next = i < last
    ? `<button class="sgt-guide-arrow sgt-guide-next" onclick="sgtGuideNext()" aria-label="下一步"><span>→</span><em>下一步</em></button>`
    : '';
  const back = `<button class="brush-btn ghost sgt-hui-btn sgt-guide-return" onclick="sgtReturnSetupFromGuide()">返 回 开 局 设 置</button>`;
  return prev + next + back;
}
function sgtGuideCenterHtml(step, i) {
  const samples = (step.samples || []).map(s => `<div class="sgt-guide-sample">${s}</div>`).join('');
  const example = step.center ? `<div class="sgt-guide-example">${step.center}</div>` : '';
  const sampleCls = step.samples && step.samples.length >= 4 ? ' sgt-guide-samples-compact' : '';
  return `
    <div class="sgt-guide-card">
      <div class="sgt-guide-kicker">游戏引导 · 第 ${i + 1} / ${SGT_GUIDE_STEPS.length} 步</div>
      <div class="sgt-guide-title">${step.title}</div>
      <div class="sgt-guide-body"><span class="sgt-guide-full">${step.body}</span><span class="sgt-guide-short">${step.shortBody || step.body}</span></div>
      ${example}
      ${samples ? `<div class="sgt-guide-samples${sampleCls}">${samples}</div>` : ''}
      ${sgtGuideNavHtml(i)}
    </div>`;
}
function sgtGuideMirror(html) {
  const echo = sgtEl('sgtEventEcho');
  if (!echo) return;
  echo.innerHTML = html;
  echo.classList.remove('pulse'); void echo.offsetWidth; echo.classList.add('pulse');
}
function sgtRenderGuideStep(i) {
  if (!sgtGuide) return;
  const last = SGT_GUIDE_STEPS.length - 1;
  sgtGuide.step = Math.max(0, Math.min(last, i));
  const step = SGT_GUIDE_STEPS[sgtGuide.step];
  sgtGuideClearFocus();
  if (SGT && SGT.players && SGT.players[0]) SGT.players[0].pos = step.playerPos == null ? 0 : step.playerPos;
  sgtRenderBoard();
  (step.focusCells || []).forEach(idx => {
    const cell = sgtEl('sgt-cell-' + idx);
    if (cell) cell.classList.add('sgt-guide-focus-cell');
  });
  const panel = sgtGuidePanel(step.focusPanel);
  if (panel) panel.classList.add('sgt-guide-focus-panel');
  const center = sgtEl('sgtCenterEvent');
  const guideHtml = sgtGuideCenterHtml(step, sgtGuide.step);
  const mobileGuide = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
  if (center) {
    center.innerHTML = mobileGuide ? '' : guideHtml;
    center.classList.add('show');
  }
  sgtGuideMirror(guideHtml);
  const banner = sgtEl('sgtTurnBanner');
  if (banner) banner.innerHTML = `游戏引导 · 第 ${sgtGuide.step + 1} / ${SGT_GUIDE_STEPS.length} 步　<b>${step.title}</b>`;
  const standings = sgtEl('sgtStandings');
  if (standings) standings.innerHTML = `
    <div class="sgt-stand cur">
      <div class="sgt-stand-top"><span class="sgt-dot" style="background:${SGT_COLORS[0].css}">${SGT_COLORS[0].glyph}</span><span class="sgt-stand-name">你</span><span class="sgt-stand-meta">令1 · 禁1 · 钱620 · 骰1 · 符1</span></div>
      <div class="sgt-stand-office-row"><span class="sgt-stand-rank robe-txt-red">从五品上</span><span class="sgt-stand-office">尚书左司郎中</span></div>
    </div>
    <div class="sgt-stand">
      <div class="sgt-stand-top"><span class="sgt-dot" style="background:${SGT_COLORS[1].css}">${SGT_COLORS[1].glyph}</span><span class="sgt-stand-name">AI 同僚<i>·托管</i></span><span class="sgt-stand-meta">钱280 · 困1</span></div>
      <div class="sgt-stand-office-row"><span class="sgt-stand-rank robe-txt-green">正八品</span><span class="sgt-stand-office">监察御史</span></div>
    </div>`;
  const log = sgtEl('sgtLog');
  if (log) log.innerHTML = `
    <div class="sgt-log-row">— 游戏引导：此处是邸报，会记录关键行动。 —</div>
    <div class="sgt-log-row"><b style="color:${SGT_COLORS[0].css}">你</b> 掷得 <b>4</b> 点，落入事件格。</div>
    <div class="sgt-log-row"><b style="color:${SGT_COLORS[1].css}">AI 同僚</b> 暂由托管代劳。</div>`;
  sgtRenderControls();
}
function sgtStartGuide() {
  sgtGuide = { step: 0 };
  SGT = {
    players: [
      Object.assign(sgtBasePlayer(), { id: 'guide-human', name: '你', color: SGT_COLORS[0], isAI: false, seat: 0 }),
      Object.assign(sgtBasePlayer(), { id: 'guide-ai', name: 'AI 同僚', color: SGT_COLORS[1], isAI: true, seat: 1, pos: 34 })
    ],
    mode: 'free', turn: 0, phase: 'guide', log: [], winner: null, winnerTeam: null,
    usurp: false, graftJackpotUsed: false, proBudget: 0, pendingChain: null,
    choiceDepth: 0, forcedDie: null, busy: false, pending: null
  };
  sgtShowPlay();
  sgtEl('sgtPlay').classList.add('sgt-guide-mode');
  const pauseBtn = sgtEl('sgtTopbarPause'), quitBtn = sgtEl('sgtTopbarQuit');
  if (pauseBtn) pauseBtn.classList.add('hidden');
  if (quitBtn) quitBtn.classList.add('hidden');
  sgtBuildBoardDom();
  sgtBindGuideKeys();
  sgtRenderGuideStep(0);
}
function sgtGuideNext() { if (sgtGuide && sgtGuide.step < SGT_GUIDE_STEPS.length - 1) sgtRenderGuideStep(sgtGuide.step + 1); }
function sgtGuidePrev() { if (sgtGuide && sgtGuide.step > 0) sgtRenderGuideStep(sgtGuide.step - 1); }
function sgtGuideKeyHandler(e) {
  if (!sgtGuide) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); sgtGuidePrev(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); sgtGuideNext(); }
}
function sgtBindGuideKeys() {
  if (sgtGuideKeyBound) return;
  document.addEventListener('keydown', sgtGuideKeyHandler);
  sgtGuideKeyBound = true;
}
function sgtUnbindGuideKeys() {
  if (!sgtGuideKeyBound) return;
  document.removeEventListener('keydown', sgtGuideKeyHandler);
  sgtGuideKeyBound = false;
}
function sgtReturnSetupFromGuide() {
  sgtGuideClearFocus();
  sgtUnbindGuideKeys();
  sgtGuide = null;
  SGT = null;
  const play = sgtEl('sgtPlay');
  if (play) { play.classList.add('hidden'); play.classList.remove('sgt-guide-mode'); }
  sgtEl('sgtSetup').classList.remove('hidden');
  const pauseBtn = sgtEl('sgtTopbarPause'), quitBtn = sgtEl('sgtTopbarQuit');
  if (pauseBtn) pauseBtn.classList.add('hidden');
  if (quitBtn) quitBtn.classList.add('hidden');
  sgtRenderSetup();
}
function sgtBasePlayer() {
  return { pos: 0, tokens: 0, bans: 0, stuck: 0, coins: 0, boughtTok: 0, boughtBan: 0, diceItems: 0, boughtDice: 0, lastFace: 0, faceStreak: 0, rank: 0, immune: 0, boughtGuard: 0, finished: false };
}

function sgtQuitGame() {
  sgtCloseVictory();
  SGT = null;
  sgtEl('sgtPlay').classList.add('hidden');
  sgtEl('sgtSetup').classList.remove('hidden');
  sgtRenderSetup();
}

/* ============================================================
   十一、音频 — 背景音乐（两曲）与掷骰音效（WebAudio 合成）
   ============================================================ */
const SGT_MUSIC = {
  1: { src: 'music/GouLan.mp3', name: '勾栏' },
  2: { src: 'music/WaShe.mp3',  name: '瓦舍' }
};
const SGT_AUDIO = { music: false, track: 1, sfx: true, ctx: null };

function sgtLoadAudioPrefs() {
  try {
    const o = JSON.parse(localStorage.getItem('sgtAudioPrefs') || '{}');
    if (typeof o.music === 'boolean') SGT_AUDIO.music = o.music;
    if (o.track === 1 || o.track === 2) SGT_AUDIO.track = o.track;
    if (typeof o.sfx === 'boolean') SGT_AUDIO.sfx = o.sfx;
  } catch (_) {}
}
function sgtSaveAudioPrefs() {
  try {
    localStorage.setItem('sgtAudioPrefs', JSON.stringify({ music: SGT_AUDIO.music, track: SGT_AUDIO.track, sfx: SGT_AUDIO.sfx }));
  } catch (_) {}
}

function sgtBgmEl() { return sgtEl('sgtBgm'); }
// 把当前曲目挂到 <audio>（仅在曲源变化时换源，避免打断）
function sgtApplyTrack() {
  const el = sgtBgmEl(); if (!el) return;
  const want = SGT_MUSIC[SGT_AUDIO.track].src;
  if (!el.getAttribute('src') || el.getAttribute('src') !== want) el.setAttribute('src', want);
  el.volume = 0.5;
}
function sgtTryPlayBgm() {
  const el = sgtBgmEl(); if (!el) return;
  const pr = el.play();
  if (pr && pr.catch) pr.catch(() => {}); // 自动播放被拦截：静默，留待下次用户手势
}

function sgtToggleMusic() {
  SGT_AUDIO.music = !SGT_AUDIO.music;
  const el = sgtBgmEl();
  if (SGT_AUDIO.music) { sgtApplyTrack(); sgtTryPlayBgm(); }
  else if (el) el.pause();
  sgtSaveAudioPrefs();
  sgtRenderSettings();
}
function sgtSetTrack(n) {
  SGT_AUDIO.track = (n === 2 || n === '2') ? 2 : 1;
  if (SGT_AUDIO.music) { sgtApplyTrack(); sgtTryPlayBgm(); }
  sgtSaveAudioPrefs();
  sgtRenderSettings();
}
function sgtToggleSfx() {
  SGT_AUDIO.sfx = !SGT_AUDIO.sfx;
  sgtSaveAudioPrefs();
  sgtRenderSettings();
}

// WebAudio 上下文（懒加载；首个用户手势后方可发声）
function sgtAudioCtx() {
  if (!SGT_AUDIO.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) { try { SGT_AUDIO.ctx = new AC(); } catch (_) {} }
  }
  if (SGT_AUDIO.ctx && SGT_AUDIO.ctx.state === 'suspended') SGT_AUDIO.ctx.resume();
  return SGT_AUDIO.ctx;
}

// 掷骰音效：以滤波噪声脉冲合成"骰子翻滚的几声清脆咔哒"，再缀一记木案"顿落"
function sgtPlayDiceSfx() {
  if (!SGT_AUDIO.sfx) return;
  const ctx = sgtAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const clackAt = [0, 0.07, 0.15, 0.225];
  clackAt.forEach((t, i) => {
    const dur = 0.05;
    const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let k = 0; k < d.length; k++) d[k] = (Math.random() * 2 - 1) * Math.pow(1 - k / d.length, 3);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1900 - i * 230; bp.Q.value = 1.3;
    const g = ctx.createGain(); g.gain.value = 0.10 + 0.045 * i;
    src.connect(bp); bp.connect(g); g.connect(ctx.destination);
    src.start(now + t);
  });
  const tEnd = now + 0.30;
  const osc = ctx.createOscillator(); osc.type = 'triangle';
  osc.frequency.setValueAtTime(210, tEnd);
  osc.frequency.exponentialRampToValueAtTime(88, tEnd + 0.12);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0.0001, tEnd);
  g2.gain.exponentialRampToValueAtTime(0.24, tEnd + 0.012);
  g2.gain.exponentialRampToValueAtTime(0.0001, tEnd + 0.19);
  osc.connect(g2); g2.connect(ctx.destination);
  osc.start(tEnd); osc.stop(tEnd + 0.22);
}

// 刷新设置面板的视觉状态（开关明灭 / 曲目可选与否）
function sgtRenderSettings() {
  const swM = sgtEl('sgtSwMusic'), swS = sgtEl('sgtSwSfx');
  if (swM) { swM.classList.toggle('on', SGT_AUDIO.music); swM.setAttribute('aria-checked', SGT_AUDIO.music ? 'true' : 'false'); }
  if (swS) { swS.classList.toggle('on', SGT_AUDIO.sfx); swS.setAttribute('aria-checked', SGT_AUDIO.sfx ? 'true' : 'false'); }
  const trackRow = sgtEl('sgtTrackRow');
  if (trackRow) trackRow.classList.toggle('sgt-set-off', !SGT_AUDIO.music);
  const r = document.querySelector('input[name="sgtTrack"][value="' + SGT_AUDIO.track + '"]');
  if (r) r.checked = true;
}
function sgtOpenSettings() { sgtRenderSettings(); sgtOpenSheet('sgtSettings'); }
function sgtReturnSetupFromSettings() {
  sgtCloseSheet('sgtSettings');
  sgtRestart();
}

function sgtInit() {
  document.querySelectorAll('input[name="sgtMode"]').forEach(r => r.addEventListener('change', sgtRenderSetup));
  document.querySelectorAll('input[name="sgtCount"]').forEach(r => r.addEventListener('change', sgtRenderModeRows));
  sgtRenderSetup();
  // 音频：载入偏好、挂曲源、刷新设置面板
  sgtLoadAudioPrefs();
  sgtApplyTrack();
  sgtRenderSettings();
  // 若上次开着音乐，待首个用户手势再续播（浏览器自动播放策略所限）
  const prime = () => {
    sgtAudioCtx();
    if (SGT_AUDIO.music) { sgtApplyTrack(); sgtTryPlayBgm(); }
    document.removeEventListener('pointerdown', prime);
    document.removeEventListener('keydown', prime);
  };
  document.addEventListener('pointerdown', prime);
  document.addEventListener('keydown', prime);
}
document.addEventListener('DOMContentLoaded', sgtInit);
