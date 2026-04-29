import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Load Google Fonts: Inter for general UI, plus Press Start 2P (chunky 8-bit
// title) and Pixelify Sans (Minecraft-ish body) for the retro gate screen.
const fontLink = document.createElement('link');
fontLink.href =
  'https://fonts.googleapis.com/css2'
  + '?family=Inter:wght@400;500;600;700'
  + '&family=Press+Start+2P'
  + '&family=Pixelify+Sans:wght@400;500;600;700'
  + '&display=swap';
fontLink.rel = 'stylesheet';
document.head.appendChild(fontLink);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
