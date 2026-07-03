import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18n } from '@iobroker/adapter-react-v5';
import translations from './i18n/translations';
import App from './App';

I18n.extendTranslations(translations);
I18n.setLanguage((window.sysLang || navigator.language || 'en').slice(0, 2));

const root = createRoot(document.getElementById('root'));
root.render(<App />);
