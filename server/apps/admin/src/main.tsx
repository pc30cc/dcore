import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider } from './i18n/I18nProvider';
import { applyRuntimeFont } from './lib/fonts';
import { runtimeConfig } from './lib/runtimeConfig';
import { ThemeProvider } from './lib/theme';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

const config = runtimeConfig();
if (config.ok) applyRuntimeFont(config.config.persianFont);

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <App />
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);
