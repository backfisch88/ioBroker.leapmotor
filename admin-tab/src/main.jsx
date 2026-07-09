import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18n } from '@iobroker/adapter-react-v5';
import translations from './i18n/translations';
import App from './App';

// Übersetzungswörterbuch bereitstellen. Die tatsächliche Sprache wird erst
// gesetzt, sobald die echte ioBroker-Systemsprache über die Socket-Verbindung
// bekannt ist (siehe useConnection.js/App.jsx) - Raten anhand der Browser-
// sprache würde bei Abweichung zwischen Browser- und ioBroker-Systemsprache
// zu falscher Anzeige führen.
I18n.extendTranslations(translations);

const root = createRoot(document.getElementById('root'));
root.render(<App />);
