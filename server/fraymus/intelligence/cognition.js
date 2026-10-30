// Cognition Module — Two-Speed Processing Pipeline by Vaughn Scott (EyeOverThink®)
// Ported from fraynix-continuity's chat loop: feel → route → think → door → answer.
// The "Right Brain" (instant emotion) runs BEFORE the "Left Brain" (LLM reasoning).

import { analyze, compose, keywords } from './heart.js';

const URL_PATTERN = /https?:\/\/[^\s]+/gi;
const QUICK_ROUTES = [
  { pattern: /^(check|show|open)\s+(inbox|mail|email)/i, action: 'check_inbox' },
  { pattern: /^(make|create|generate)\s+(image|picture|photo)/i, action: 'generate_image' },
  { pattern: /^(check|search|look up|find)\s+(it|this|that)/i, action: 'web_search' },
  { pattern: /^(what time|what date|current time)/i, action: 'clock' },
  { pattern: /^(status|health|how are you)/i, action: 'self_status' },
  { pattern: /^(dream|imagine|consolidate)/i, action: 'dream' },
  { pattern: /^(evolve|mutate|fitness)/i, action: 'evolve' },
  { pattern: /^(feel|emotion|mood|how do i feel)/i, action: 'feel_report' },
];

export class CognitionPipeline {
  constructor({ heart, ledger, dreamer, ouroboros, ollamaChat }) {
    this.heart = heart;
    this.ledger = ledger;
    this.dreamer = dreamer;
    this.ouroboros = ouroboros;
    this.ollamaChat = ollamaChat;
    this.conversationContext = [];
    this.maxDoorSteps = 4;
  }

  async process(userText, options = {}) {
    const startMs = Date.now();

    // 1. FEEL — instant emotion read (no model, ~0ms)
    const feeling = this.heart ? this.heart.feel(userText, this.conversationContext) : analyze(userText);

    if (this.ledger) {
      this.ledger.record('cognition.feel', {
        primary: feeling.primary,
        intensity: feeling.intensity,
        sentiment: feeling.sentiment,
      }, 'cognition');
    }

    // 2. QUICK-ROUTE — pattern match for instant actions (~0ms)
    const route = this._quickRoute(userText);
    if (route) {
      if (this.ledger) this.ledger.record('cognition.route', { action: route.action }, 'cognition');
      return {
        phase: 'quick-route',
        action: route.action,
        feeling,
        durationMs: Date.now() - startMs,
        quick: true,
      };
    }

    // 3. THINK — LLM reasoning with emotion context injected as private notes
    const privateNotes = [
      `[emotion: ${feeling.primary} (${Math.round(feeling.intensity * 100)}%)]`,
      `[sentiment: ${feeling.sentiment > 0 ? 'positive' : feeling.sentiment < 0 ? 'negative' : 'neutral'}]`,
      feeling.sarcasm ? '[sarcasm detected]' : '',
      `[quick-thought: ${feeling.quick || compose(userText, feeling)}]`,
    ].filter(Boolean).join(' ');

    let llmResponse = null;
    if (this.ollamaChat && !options.skipThink) {
      const messages = [
        ...this.conversationContext.slice(-10),
        { role: 'system', content: `Private emotional context (never repeat to user): ${privateNotes}` },
        { role: 'user', content: userText },
      ];

      try {
        llmResponse = await this.ollamaChat(messages);
        if (this.ledger) this.ledger.record('cognition.think', { model: 'ollama', length: llmResponse?.length || 0 }, 'cognition');
      } catch (e) {
        if (this.ledger) this.ledger.record('cognition.think.error', { error: e.message }, 'cognition');
      }
    }

    // 4. Update conversation context
    this.conversationContext.push({
      role: 'user',
      text: userText,
      triggers: feeling.triggers,
      primary: feeling.primary,
    });
    if (llmResponse) {
      this.conversationContext.push({ role: 'assistant', text: llmResponse });
    }
    if (this.conversationContext.length > 50) {
      this.conversationContext = this.conversationContext.slice(-30);
    }

    return {
      phase: 'think',
      feeling,
      privateNotes,
      response: llmResponse,
      keywords: keywords(userText),
      durationMs: Date.now() - startMs,
      quick: false,
    };
  }

  _quickRoute(text) {
    if (URL_PATTERN.test(text)) return { action: 'fetch_url', match: text.match(URL_PATTERN)[0] };
    for (const r of QUICK_ROUTES) {
      if (r.pattern.test(text)) return { action: r.action };
    }
    return null;
  }

  status() {
    return {
      contextLength: this.conversationContext.length,
      maxDoorSteps: this.maxDoorSteps,
      modules: {
        heart: !!this.heart,
        ledger: !!this.ledger,
        dreamer: !!this.dreamer,
        ouroboros: !!this.ouroboros,
        ollamaChat: !!this.ollamaChat,
      },
    };
  }
}
