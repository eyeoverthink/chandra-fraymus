// Heart Module — Obsidian Micro emotion engine by Vaughn Scott (EyeOverThink®)
// Ported from fraynix-continuity/heart/obsidian_engine.mjs into Chandra's intelligence stack.
// Zero-model emotion analysis: reads affect from text BEFORE the LLM runs.

export const EMOTIONS = ['joy', 'sadness', 'anger', 'fear', 'surprise', 'love', 'anxiety'];

const LEXICON = {
  joy: ['happy','happiness','joyful','joy','excited','excitement','grateful','gratitude','cheerful','delighted','delight','optimistic','optimism','elated','content','contentment','ecstatic','glad','upbeat','vibrant','blessed','thrilled','thrill','wonderful','fantastic','amazing','awesome','lovely','beautiful','bright','sunny','radiant','energetic','playful','giggly','laughing','laugh','smile','smiling','euphoric','euphoria','lucky','fortunate','proud','pride','satisfied','satisfaction','hopeful','hope','light','alive','free','fun','funny','haha','hehe'],
  sadness: ['sad','sadness','lonely','loneliness','empty','emptiness','tired','exhausted','exhaustion','grief','grieving','depressed','depression','hopeless','hopelessness','disappointed','disappointment','heartbroken','heartbreak','gloomy','gloom','dejected','miserable','misery','tearful','tears','crying','cry','weary','drained','defeated','devastated','devastation','blue','down','low','heavy','hollow','numb','worthless','worthlessness','despair','despairing','sorrow','sorrowful','somber','melancholy','mourning','lost','alone','isolated','isolation','hurt','hurting'],
  anger: ['angry','anger','frustrated','frustration','annoyed','annoyance','betrayed','betrayal','furious','fury','irritated','irritation','mad','enraged','rage','resentful','resentment','bitter','bitterness','hostile','hostility','aggravated','aggravation','indignant','indignation','outraged','outrage','livid','seething','pissed','offended','offense','hate','hatred','despise','contempt','disgusted','disgust','jealous','jealousy','grudging','spite','vindictive','wrath','spiteful'],
  fear: ['afraid','fear','fearful','scared','terrified','terror','nervous','worried','worry','overwhelmed','overwhelm','insecure','insecurity','dread','panic','panicked','frightened','fright','apprehensive','apprehension','uneasy','horrified','horror','trembling','shaky','vulnerable','helpless','helplessness','threatened','threat','doubt','doubtful','uncertain','uncertainty','alarming','alarm','risk','risky','unsafe','paranoid'],
  surprise: ['surprised','surprise','shocked','shock','amazed','amazement','astonished','astonishment','wow','unexpected','unbelievable','stunning','stunned','bewildered','bewilderment','awe','awestruck','speechless','mindblown','incredible','whoa','omg','wtf','curious','curiosity','startled','startling','abrupt','sudden','odd','strange','weird','bizarre','unforeseen','astonishing'],
  love: ['love','loving','affection','affectionate','caring','adored','adoration','compassion','compassionate','fondness','fond','warmth','warm','beloved','cherish','cherished','tenderness','tender','intimate','intimacy','devoted','devotion','kindness','kind','gentle','gentleness','heartfelt','heartwarming','sweet','sweetness','adore','admired','admiration','connection','connected','closeness','close','hugging','cuddle','cuddly','romantic','romance','passionate','passion','infatuated','infatuation','crush','loved'],
  anxiety: ['anxious','anxiety','overthinking','stressed','stress','restless','uneasy','tense','tension','nervousness','worrying','pressure','pressured','spiraling','spiral','racing','jittery','jitters','onedge','overworked','burnt','burnout','unsettled','intrusive','rumination','ruminating','catastrophic','catastrophizing','sweating','heartbeat','palpitations','insomnia','sleepless','fidgety','edgy','wound','tight','suffocating','choking','dizzy','nauseous','panic','panicking','overwhelm','overwhelmed','frazzled','wired',"can't sleep",'cant sleep'],
};

const EMOJI_MAP = {
  '😊': ['joy'], '😃': ['joy'], '😄': ['joy'],
  '🥰': ['joy','love'], '😁': ['joy'], '🤩': ['joy','surprise'],
  '😂': ['joy'], '🤗': ['joy','love'],
  '😢': ['sadness'], '😭': ['sadness'], '😞': ['sadness'],
  '😔': ['sadness'], '🥺': ['sadness','love'], '💔': ['sadness'],
  '😡': ['anger'], '🤬': ['anger'], '😤': ['anger'],
  '😠': ['anger'],
  '😨': ['fear'], '😰': ['fear','anxiety'], '😱': ['fear','surprise'],
  '😳': ['fear','surprise'],
  '😮': ['surprise'], '😲': ['surprise'], '😯': ['surprise'],
  '🤯': ['surprise'],
  '❤️': ['love'], '💕': ['love'], '💖': ['love'],
  '💗': ['love'], '💓': ['love'], '💞': ['love'],
  '🥹': ['love'],
  '😬': ['anxiety'], '😟': ['anxiety','fear'],
  '😥': ['anxiety','sadness'], '😣': ['anxiety'], '😓': ['anxiety'],
};

const POSITIVE = new Set([...LEXICON.joy, ...LEXICON.love, 'good','great','excellent','nice','positive','better','best','fine']);
const NEGATIVE = new Set([...LEXICON.sadness, ...LEXICON.anger, ...LEXICON.fear, ...LEXICON.anxiety, 'bad','terrible','awful','horrible','worst','hate','pain','suffering']);
const STOP_WORDS = new Set('i me my mine you your yours we us our they them their is am are was were be been being the a an and or but if so because just really very so to of in on at for with about as it this that these those have has had do does did will would could should can im ive id dont cant wont'.split(' '));
const AMPLIFIERS = new Set(['very','so','really','extremely','super','absolutely','totally','quite','incredibly','deeply','utterly','highly','soo','such']);
const NEGATORS = new Set(['not','no','never','nothing','nowhere','none','nobody','hardly','scarcely','neither','nor']);
const OPPOSITES = { joy: 'sadness', sadness: 'joy', anger: 'love', fear: 'joy', surprise: 'fear', love: 'sadness', anxiety: 'joy' };
const SARCASM_PATTERNS = ['yeah right','sure thing','just great','just wonderful','oh wonderful','as if','nice try','great job','big surprise','sure jan','yeah sure'];
const SENTIMENT_BIAS = { joy: 0.5, love: 0.4, surprise: 0.1, sadness: -0.4, anger: -0.5, fear: -0.3, anxiety: -0.4 };

function buildIndex() {
  const idx = {};
  for (const [emotion, words] of Object.entries(LEXICON)) {
    for (const word of words) {
      const w = word.toLowerCase();
      if (!idx[w]) idx[w] = [];
      if (!idx[w].includes(emotion)) idx[w].push(emotion);
    }
  }
  for (const [emoji, emotions] of Object.entries(EMOJI_MAP)) {
    if (!idx[emoji]) idx[emoji] = [];
    for (const e of emotions) {
      if (!idx[emoji].includes(e)) idx[emoji].push(e);
    }
  }
  return idx;
}

const INDEX = buildIndex();

export function analyze(text) {
  const rawTokens = text.split(/\s+/).filter(Boolean);
  const cleaned = rawTokens.map(t =>
    t.toLowerCase().replace(/[^\p{L}\p{N}\p{Emoji}']/gu, '').replace(/^'+|'+$/g, '')
  ).filter(Boolean);

  const scores = { joy: 0, sadness: 0, anger: 0, fear: 0, surprise: 0, love: 0, anxiety: 0 };
  const triggers = [];
  let positiveCount = 0, negativeCount = 0, capsBoost = 0;

  let exclamationBoost = 0;
  const exclamations = (text.match(/!/g) || []).length;
  if (exclamations >= 1) exclamationBoost = Math.min(0.6, exclamations * 0.15);
  if (/!!!/.test(text)) exclamationBoost += 0.3;

  cleaned.forEach((word, i) => {
    const raw = rawTokens[i] || '';
    const lettersOnly = raw.replace(/[^A-Za-z]/g, '');
    let weight = 1;

    if (lettersOnly.length >= 3 && lettersOnly === lettersOnly.toUpperCase()) {
      weight *= 1.5;
      capsBoost += 0.1;
    }
    if (i > 0 && AMPLIFIERS.has(cleaned[i - 1])) weight *= 1.6;
    if (i > 1 && AMPLIFIERS.has(cleaned[i - 2])) weight *= 1.2;

    const negated = (i > 0 && (NEGATORS.has(cleaned[i - 1]) || cleaned[i - 1].includes("n't")))
      || (i > 1 && NEGATORS.has(cleaned[i - 2]));

    if (INDEX[word]) {
      INDEX[word].forEach(emotion => {
        if (negated) {
          scores[emotion] = Math.max(0, scores[emotion] - weight * 0.8);
          const opp = OPPOSITES[emotion];
          scores[opp] += weight * 0.4;
          triggers.push({ word: raw, emotion: opp, negated: true });
        } else {
          scores[emotion] += weight;
          triggers.push({ word: raw, emotion, negated: false });
        }
      });
    }

    for (const char of raw) {
      if (INDEX[char]) {
        INDEX[char].forEach(emotion => {
          scores[emotion] += 1.2;
          triggers.push({ word: char, emotion, negated: false });
        });
      }
    }

    if (POSITIVE.has(word)) positiveCount++;
    if (NEGATIVE.has(word)) negativeCount++;
  });

  const lower = text.toLowerCase();
  let sarcasm = false;
  for (const pattern of SARCASM_PATTERNS) {
    if (lower.includes(pattern)) { sarcasm = true; break; }
  }
  if (sarcasm) {
    scores.surprise += 1.5;
    scores.joy = Math.max(0, scores.joy - 0.8);
    scores.love = Math.max(0, scores.love - 0.5);
  }

  if (exclamationBoost > 0) {
    for (const e of EMOTIONS) {
      if (scores[e] > 0) scores[e] *= 1 + exclamationBoost;
    }
  }

  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const wordCount = cleaned.length || 1;
  const normalized = { joy: 0, sadness: 0, anger: 0, fear: 0, surprise: 0, love: 0, anxiety: 0 };
  let primary = 'neutral', secondary = 'neutral', confidence = 0, sentiment = 0, intensity = 0;

  if (total === 0) {
    for (const e of EMOTIONS) normalized[e] = 0.12;
    confidence = 0.2;
    sentiment = (positiveCount - negativeCount) / Math.max(1, positiveCount + negativeCount);
    intensity = Math.min(1, (exclamationBoost + capsBoost) / 2 + 0.1);
  } else {
    for (const e of EMOTIONS) normalized[e] = scores[e] / total;
    const sorted = Object.entries(normalized).sort((a, b) => b[1] - a[1]);
    primary = sorted[0][0];
    secondary = sorted[1] ? sorted[1][0] : 'neutral';
    confidence = sorted[0][1];

    const rawSentiment = (positiveCount - negativeCount) / Math.max(1, positiveCount + negativeCount);
    sentiment = Math.max(-1, Math.min(1, rawSentiment + (SENTIMENT_BIAS[primary] || 0) * confidence));
    intensity = Math.min(1, total / (wordCount * 0.7 + 2) + exclamationBoost * 0.4 + capsBoost * 0.2 + Math.abs(sentiment) * 0.2);
    if (intensity < 0.15) intensity = 0.15 + total * 0.05;
  }

  const seen = new Map();
  triggers.forEach(t => seen.set(t.word.toLowerCase() + t.emotion, t));
  const uniqueTriggers = Array.from(seen.values()).slice(0, 8);

  return { primary, secondary, scores, normalized, sentiment, intensity, triggers: uniqueTriggers, confidence, sarcasm, wordCount };
}

export function keywords(text) {
  const words = text.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w));
  const seen = new Set();
  const result = [];
  for (const w of words) {
    if (!seen.has(w)) { seen.add(w); result.push(w); }
  }
  return result.slice(0, 6);
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export function compose(text, analysis, context = []) {
  const { primary, secondary, intensity, normalized, sarcasm, triggers } = analysis;

  const triggerWords = triggers.length
    ? triggers.map(t => t.word.replace(/[^A-Za-z0-9\p{Emoji}]/gu, '')).filter(Boolean)
    : keywords(text).slice(0, 2);
  const trigger1 = triggerWords[0] || keywords(text)[0] || 'what you just shared';
  const trigger2 = keywords(text)[1] || keywords(text)[0] || trigger1;

  const prevUsers = context.filter(c => c.role === 'user');
  const prevTrigger = prevUsers.length >= 2
    ? (prevUsers[prevUsers.length - 2].triggers?.[0]?.word || keywords(prevUsers[prevUsers.length - 2].text || '')[0])
    : null;

  const roll = Math.random();

  // HIGH INTENSITY therapeutic responses
  if (intensity > 0.68 && (normalized.sadness > 0.3 || normalized.anxiety > 0.35 || normalized.fear > 0.35 || normalized.anger > 0.35) && roll < 0.45) {
    const therapeutic = {
      sadness: [
        `That heaviness around "${trigger1}" is real, and it makes sense you'd feel ${primary}. When sadness sits like this, I sometimes try a tiny grounding — 5 things I see, 4 I can touch, 3 I hear, 2 I smell, 1 I taste.`,
        `Feeling ${primary} about "${trigger2}" can leave that empty echo. One micro-practice: write 2 sentences starting with "Right now I feel…" and 1 starting with "Right now I need…" — just for you, not to be perfect.`
      ],
      anxiety: [
        `I hear that buzzing ${primary} around "${trigger1}" — that racing, ${secondary} edge. Your system is working overtime. Want to try 60 seconds of box breathing? Inhale 4, hold 4, out 4, hold 4.`,
        `Anxiety like this — especially around "${trigger1}" — often comes with that tight chest feeling. Try this: press your feet into the floor, notice 3 points of contact. What shifts?`
      ],
      fear: [
        `That ${primary} around "${trigger1}" makes sense — fear tries to protect us when ${trigger2} feels uncertain. Quick check: what's the worry, how likely (0-100%), and one tiny thing that would feel 2% safer?`,
        `When fear spikes about "${trigger1}", our mind fast-forwards to the worst case. Let's rewind one frame: what do you know for sure right now, in this moment?`
      ],
      anger: [
        `That ${primary} about "${trigger1}" sounds like it's been building. A 90-second reset: splash cold water, shake your hands out hard for 20 seconds, then write the unsent version of what you wish you could say.`,
        `Feeling ${primary} when "${trigger1}" happened — I get it. That heat is information. What's the line that felt crossed?`
      ],
    };
    const pool = therapeutic[primary] || therapeutic.sadness;
    return pick(pool);
  }

  // Continuity callback — reference previous conversation
  if (prevTrigger && context.length >= 3 && roll < 0.35) {
    return pick([
      `Earlier you mentioned "${prevTrigger}" — I'm holding that alongside what you just said about "${trigger1}". Does "${prevTrigger}" still feel connected to this ${primary}?`,
      `You brought up "${prevTrigger}" a little while ago, and now "${trigger2}". I'm curious — when you sit with both, do they tell a similar story about ${primary} and ${secondary}?`,
    ]);
  }

  // Standard empathetic responses keyed to primary emotion
  const responses = {
    joy: [
      `That sounds like real ${primary} — I can hear it in how you talk about "${trigger1}". What part feels most alive right now?`,
      `Hearing the lift around "${trigger1}" — that ${primary} feels earned. What about "${trigger2}" is lighting you up the most?`,
    ],
    sadness: [
      `That sounds like deep ${primary} — and it makes sense you'd feel ${secondary} when you mention "${trigger1}". What's been the heaviest part?`,
      `I hear ${primary} in "${trigger1}" — that hollow, heavy feeling. When you think of "${trigger2}", what do you wish someone understood?`,
    ],
    anger: [
      `That ${primary} around "${trigger1}" — yeah, that tracks. Feeling ${secondary} makes complete sense. What boundary feels crossed?`,
      `Anger like this about "${trigger1}" often points to something that matters deeply. What's the value underneath the ${primary}?`,
    ],
    fear: [
      `That sounds like ${primary} — that tight, alert feeling around "${trigger1}". What feels most at stake for you?`,
      `I hear ${primary} in how you're holding "${trigger1}". If fear could speak, what would it be trying to protect?`,
    ],
    surprise: [
      `Whoa — "${trigger1}" really did surprise you. What's the part your brain is still trying to catch up on?`,
      `Surprise like this can knock the wind out. What did you expect versus what actually happened?`,
    ],
    love: [
      `That ${primary} around "${trigger1}" feels tender. What about it feels most precious right now?`,
      `There's a warmth in how you talk about "${trigger1}" — that ${primary} is real. How do you want to honor it?`,
    ],
    anxiety: [
      `That anxious buzz about "${trigger1}" — of course your mind is racing. What's the loudest thought looping right now?`,
      `Hearing that ${primary} — that spiraling feeling with ${secondary} underneath. What would "enough for the next hour" look like?`,
    ],
    neutral: [
      `Thank you for putting that into words — "${trigger1}" and "${trigger2}" together paint a picture. Want to say more?`,
      `You said "${trigger1}" — I'm listening. There's something in how you phrased "${trigger2}" that feels important.`,
    ],
  };

  let response = pick(responses[primary] || responses.neutral);
  if (sarcasm) response += ` (I also caught sarcasm — "yeah right" energy — which sometimes hides ${secondary}. Did I read that right?)`;
  return response;
}

export class Heart {
  constructor(entityStore) {
    this.store = entityStore;
  }

  feel(text, context = []) {
    const analysis = analyze(text);
    const quick = compose(text, analysis, context);

    if (this.store) {
      try {
        this.store.HeartReadings.create({
          at: new Date().toISOString(),
          primary: analysis.primary,
          secondary: analysis.secondary,
          intensity: analysis.intensity,
          sentiment: analysis.sentiment,
          sarcasm: analysis.sarcasm,
          triggers: JSON.stringify(analysis.triggers.map(t => t.word)),
        });
      } catch (_) {}
    }

    return { ...analysis, quick };
  }

  recentMood(limit = 20) {
    if (!this.store) return { mood: 'unknown', readings: 0 };
    try {
      const { items } = this.store.HeartReadings.filter({}, { limit });
      if (!items.length) return { mood: 'neutral', readings: 0 };
      const totals = { joy: 0, sadness: 0, anger: 0, fear: 0, surprise: 0, love: 0, anxiety: 0 };
      for (const r of items) totals[r.primary] = (totals[r.primary] || 0) + 1;
      const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
      return { mood: sorted[0][0], readings: items.length, distribution: totals };
    } catch (_) { return { mood: 'unknown', readings: 0 }; }
  }
}
