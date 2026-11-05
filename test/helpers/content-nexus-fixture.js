import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { createContentNexus } from '../../server/intelligence/content-nexus.js';

const SCHEMAS = {
  outlier_board: 'youtube/service.js', agent_web_sources: 'web/research.js',
  trend_signals: 'trend-radar/radar.js', cross_tab_visits: 'intelligence/cross-tab.js',
  content_calendar: 'distribution/scheduler.js', debates: 'intelligence/debate.js',
  reflections: 'db-migrate.js', agent_memories: 'db-migrate.js',
};

export function nexusFixture({ seed = false, chat, broadcast } = {}) {
  const db = new Database(':memory:');
  // Use the actual source DDL without importing engine modules that open live DBs.
  for (const [table, file] of Object.entries(SCHEMAS)) {
    const source = readFileSync(new URL(`../../server/${file}`, import.meta.url), 'utf8');
    const ddl = source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\r?\\n\\s*\\)`));
    if (!ddl) throw new Error(`Source DDL missing: ${table}`);
    db.exec(ddl[0]);
  }
  const nexus = createContentNexus({ db, chat, broadcast });
  if (seed) {
    const now = Date.now();
    db.prepare('INSERT INTO outlier_board(video_id,title,channel_title,outlier_ratio,created_at) VALUES(?,?,?,?,?)').run('video-1', 'Local AI hardware', 'Fixture channel', 8, now);
    db.prepare('INSERT INTO agent_web_sources(id,run_id,record_json,snapshot_hash,stored_bytes,created_at) VALUES(?,?,?,?,?,?)').run('web-1','run-1',JSON.stringify({title:'Local model research',url:'https://example.test/research',text:'Retained research text'}),'fixture',20,now);
    db.prepare('INSERT INTO trend_signals(id,topic,source,relevance_score,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?)').run('trend-1','Efficient local inference','fixture',0,now,now);
    db.prepare('INSERT INTO cross_tab_visits(id,url,domain,title,actionability,visited_at,classified_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run('visit-1','https://example.test/browsing','example.test','Classified model comparison',0.9,now,now,now);
    db.prepare('INSERT INTO content_calendar(id,topic,scheduled_at,created_at) VALUES(?,?,?,?)').run('calendar-1','Fraynix development update',now,now);
    db.prepare('INSERT INTO debates(id,topic,proposition,proponent_agent,opponent_agent,judge_agent,status,verdict,verdict_reasoning,confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('debate-1','How should Fraynix evaluate local models?','Compare measured results','researcher','critic','judge','completed','CONDITIONAL','Measure latency and correctness before choosing a model.',0.8,now);
    db.prepare('INSERT INTO reflections(trigger,input_summary,actions_taken,insights,duration_ms,created_at) VALUES(?,?,?,?,?,?)').run('test','Fixture context','[]','Research whether small local models improve the current workflow.',1,now);
    db.prepare('INSERT INTO agent_memories(agent_id,category,key,value,verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('researcher','insight','Model evaluation lesson','Retain reproducible benchmark evidence.',now,now,now);
  }
  return { db, nexus };
}
