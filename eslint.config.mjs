// ioBroker eslint configuration file for js files
import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        // specify files to exclude from linting here
        ignores: [
            'admin/**',
            // admin-tab is a separate React/Vite sub-project with its own
            // package.json and build tooling (JSX, browser globals, React
            // hooks rules) - none of which this Node-oriented adapter
            // config is set up for. 'build/**' was already excluded; 'src/**'
            // was missed, so translations.js and the .jsx components were
            // being linted against rules meant for the backend adapter code.
            'admin-tab/src/**',
            'admin-tab/build/**',
            'admin-tab/node_modules/**',
            'admin-tab/vite.config.js',
            'test/**/*.js',
            '*.config.mjs',
        ],
    },
];
