// ioBroker eslint configuration file for js files
import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        // specify files to exclude from linting here
        ignores: [
            'admin/**',
            'admin-tab/build/**',
            'admin-tab/node_modules/**',
            'test/**/*.js',
            '*.config.mjs',
        ],
    },
];
