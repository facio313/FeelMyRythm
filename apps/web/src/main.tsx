import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { APP_BASENAME } from './lib/paths';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={APP_BASENAME}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
