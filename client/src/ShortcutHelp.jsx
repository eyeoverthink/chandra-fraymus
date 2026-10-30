import React from 'react';
import { SHORTCUTS } from './useKeyboardShortcuts.js';

export default function ShortcutHelp({ onClose }) {
  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        zIndex: 10000, cursor: 'pointer',
      }} />
      <div style={{
        position: 'fixed', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        background: '#14141e', border: '1px solid #2a2a3a',
        borderRadius: 14, padding: '24px 28px',
        boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
        zIndex: 10001, minWidth: 320, maxWidth: 400,
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: 16,
        }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#e2e8f0' }}>
            Keyboard Shortcuts
          </h2>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: '#555',
            fontSize: 18, cursor: 'pointer', padding: '2px 6px',
          }}>x</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {SHORTCUTS.map(s => (
            <div key={s.action} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '6px 0',
            }}>
              <span style={{ fontSize: 13, color: '#94a3b8' }}>{s.label}</span>
              <kbd style={{
                padding: '3px 8px', borderRadius: 5,
                background: '#1e1e2e', border: '1px solid #333',
                color: '#a78bfa', fontSize: 12, fontFamily: 'monospace',
                minWidth: 28, textAlign: 'center',
              }}>
                {s.ctrl ? 'Ctrl+' : ''}{s.key === 'Escape' ? 'Esc' : s.key}
              </kbd>
            </div>
          ))}
        </div>
        <div style={{
          marginTop: 16, paddingTop: 12, borderTop: '1px solid #222',
          fontSize: 11, color: '#444', textAlign: 'center',
        }}>
          Number keys work outside of text inputs
        </div>
      </div>
    </>
  );
}
