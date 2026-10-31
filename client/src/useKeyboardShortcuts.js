import { useEffect, useCallback } from 'react';

const SHORTCUTS = [
  { key: 'k', ctrl: true, action: 'search', label: 'Open search' },
  { key: '1', ctrl: false, action: 'view:command', label: 'Command Center' },
  { key: '2', ctrl: false, action: 'view:constellation', label: 'Constellation' },
  { key: '3', ctrl: false, action: 'view:canvas', label: 'Canvas' },
  { key: '4', ctrl: false, action: 'view:library', label: 'Library' },
  { key: '5', ctrl: false, action: 'chat', label: 'Agent Chat' },
  { key: '6', ctrl: false, action: 'timeline', label: 'Activity Timeline' },
  { key: '7', ctrl: false, action: 'metrics', label: 'System Metrics' },
  { key: '8', ctrl: false, action: 'profiles', label: 'Agent Profiles' },
  { key: '9', ctrl: false, action: 'memory', label: 'Memory Browser' },
  { key: '0', ctrl: false, action: 'run-history', label: 'Run History' },
  { key: 'e', ctrl: true, action: 'evolution', label: 'Evolution Log' },
  { key: 'p', ctrl: true, action: 'pulse', label: 'System Pulse' },
  { key: 'l', ctrl: true, action: 'leaderboard', label: 'Agent Leaderboard' },
  { key: 'j', ctrl: true, action: 'collab', label: 'Agent Collaboration' },
  { key: 'Escape', ctrl: false, action: 'close', label: 'Close drawer / search' },
  { key: '?', ctrl: false, action: 'help', label: 'Show shortcuts' },
];

export { SHORTCUTS };

export default function useKeyboardShortcuts({ onAction }) {
  const handler = useCallback((e) => {
    const tag = e.target.tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable;

    if (e.key === 'Escape') {
      onAction('close');
      return;
    }

    if (e.ctrlKey && e.key === 'k') {
      e.preventDefault();
      onAction('search');
      return;
    }

    if (e.ctrlKey && e.key === 'e') {
      e.preventDefault();
      onAction('evolution');
      return;
    }

    if (e.ctrlKey && e.key === 'p') {
      e.preventDefault();
      onAction('pulse');
      return;
    }

    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      onAction('leaderboard');
      return;
    }

    if (e.ctrlKey && e.key === 'j') {
      e.preventDefault();
      onAction('collab');
      return;
    }

    if (isInput) return;

    if (e.key === '?') {
      onAction('help');
      return;
    }

    if (e.key >= '1' && e.key <= '4' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const views = ['command', 'constellation', 'canvas', 'library'];
      onAction(`view:${views[parseInt(e.key) - 1]}`);
      return;
    }

    if (e.key === '5' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      onAction('chat');
      return;
    }
    if (e.key === '6' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      onAction('timeline');
      return;
    }
    if (e.key === '7' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      onAction('metrics');
      return;
    }
    if (e.key === '8' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      onAction('profiles');
      return;
    }
    if (e.key === '9' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      onAction('memory');
      return;
    }
    if (e.key === '0' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      onAction('run-history');
      return;
    }
  }, [onAction]);

  useEffect(() => {
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handler]);
}
