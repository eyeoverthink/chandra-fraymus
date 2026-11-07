import { useState } from 'react';
import CommandView from './CommandView.jsx';
import BrainGraph from './BrainGraph.jsx';
import CreateView from './CreateView.jsx';
import CoreView from './CoreView.jsx';
import './fraymus.css';

const SURFACES = [
  { id: 'command', label: 'Command' },
  { id: 'brain', label: 'Second brain' },
  { id: 'create', label: 'Create' },
  { id: 'core', label: 'Core' },
];

export default function FraymusApp({ wsStatus }) {
  const [surface, setSurface] = useState('command');
  const [brainQuery, setBrainQuery] = useState('');

  return (
    <div className="fraymus-root">
      <nav className="fraymus-surfaces" aria-label="F.R.A.Y.M.U.S. surfaces">
        {SURFACES.map(item => (
          <button key={item.id} type="button" className={surface === item.id ? 'on' : ''} onClick={() => setSurface(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>
      {surface === 'command' && (
        <CommandView
          wsStatus={wsStatus}
          onOpenSurface={setSurface}
          onInspect={value => { setBrainQuery(value || ''); setSurface('brain'); }}
        />
      )}
      {surface === 'brain' && <BrainGraph initialQuery={brainQuery} />}
      {surface === 'create' && <CreateView />}
      {surface === 'core' && <CoreView />}
    </div>
  );
}
