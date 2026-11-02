import { heart } from '../fraymus-tools.js';
import { createCreationIntel } from './shared.js';
import {
  runCreationPipeline,
  runCreativeBrief,
  runScriptWriter,
  runVoiceSynth,
  runVisualAssembly,
  runDistributionPrep,
  runCommerceBridge,
} from './pipeline.js';

const string = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const object = (properties, required = []) => ({ type: 'object', properties, required });

export function createCreationTools({ memoryBridge, broadcast } = {}) {
  const intel = createCreationIntel(memoryBridge, heart);
  return [
    {
      name: 'creation.brief',
      group: 'creation',
      risk: 'safe',
      description: 'Generate a creative brief from a topic using intelligence stack signals (dreams, emotions, REA findings, outlier data).',
      parameters: object({
        topic: string(500, { description: 'The topic or concept for the creative piece' }),
        format: string(50, { enum: ['short_video', 'long_video', 'podcast', 'social_post', 'hyperframes'], description: 'Content format' }),
        style: string(100, { description: 'Visual/tonal style direction (or "auto" for intelligence-driven)' }),
      }, ['topic']),
      execute: async ({ args }) => runCreativeBrief(args, { intel }),
    },
    {
      name: 'creation.script',
      group: 'creation',
      risk: 'safe',
      description: 'Write a production script with shot list, narration, and timing from a creative brief. Pass the output of creation.brief.',
      parameters: object({
        brief: { type: 'object', description: 'Creative brief from creation.brief' },
        topic: string(500),
        format: string(50),
      }, ['brief', 'topic']),
      execute: async ({ args }) => runScriptWriter(args),
    },
    {
      name: 'creation.voice',
      group: 'creation',
      risk: 'safe',
      description: 'Synthesize narration audio from a script using voice clone (port 9099) or TTS cascade (Piper/edge-tts/SAPI). Pass the output of creation.script.',
      parameters: object({
        script: { type: 'object', description: 'Script from creation.script' },
        topic: string(500),
      }, ['script', 'topic']),
      execute: async ({ args }) => runVoiceSynth(args),
    },
    {
      name: 'creation.visuals',
      group: 'creation',
      risk: 'safe',
      description: 'Assemble visual compositions (image prompts + HyperFrames specs) from script and voice output. Pass the output of creation.voice.',
      parameters: object({
        script: { type: 'object', description: 'Script data' },
        narration: string(10000, { description: 'Narration text' }),
        audio: { type: 'object', description: 'Audio result from creation.voice' },
        topic: string(500),
      }, ['script', 'topic']),
      execute: async ({ args }) => runVisualAssembly(args),
    },
    {
      name: 'creation.distribute',
      group: 'creation',
      risk: 'safe',
      description: 'Prepare platform-specific distribution packages (metadata, thumbnails, hashtags) for assembled content. Pass the output of creation.visuals.',
      parameters: object({
        compositions: { type: 'array', description: 'Visual compositions from creation.visuals' },
        heroImage: string(1000),
        audio: { type: 'object' },
        script: { type: 'object' },
        topic: string(500),
        brief: { type: 'object' },
      }, ['compositions', 'topic']),
      execute: async ({ args }) => runDistributionPrep(args),
    },
    {
      name: 'creation.commerce_bridge',
      group: 'creation',
      risk: 'safe',
      description: 'Bridge creation output to the commerce pipeline — checks for existing product listings and recommends commerce pipeline runs for commercial content.',
      parameters: object({
        brief: { type: 'object', description: 'Creative brief with commerce_tie_in field' },
        topic: string(500),
        packages: { type: 'array', description: 'Distribution packages' },
      }, ['topic']),
      execute: async ({ args }) => runCommerceBridge(args),
    },
    {
      name: 'creation.full_pipeline',
      group: 'creation',
      risk: 'approval',
      description: 'Run the full 6-stage creation pipeline: Brief → Script → Voice → Visuals → Distribution → Commerce Bridge. Intelligence-driven end-to-end content production.',
      parameters: object({
        topic: string(500, { description: 'The topic or concept' }),
        format: string(50, { enum: ['short_video', 'long_video', 'podcast', 'social_post', 'hyperframes'] }),
        style: string(100, { description: 'Visual/tonal style direction' }),
      }, ['topic']),
      execute: async ({ args }) => runCreationPipeline(args, { intel, broadcast }),
    },
  ];
}
