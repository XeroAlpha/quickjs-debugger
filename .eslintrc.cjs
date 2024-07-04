module.exports = {
    root: true,
    plugins: [
        '@typescript-eslint',
        'prettier'
    ],
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/strict-type-checked',
        'plugin:@typescript-eslint/stylistic-type-checked',
        'prettier'
    ],
    parser: '@typescript-eslint/parser',
    parserOptions: {
        project: [
            './tsconfig.json',
            './tsconfig.eslint.json'
        ],
        tsconfigRootDir: __dirname,
    },
    env: {
        node: true,
        es2020: true
    },
    rules: {
        'prettier/prettier': 'error',
        '@typescript-eslint/no-unsafe-declaration-merging': 'off'
    }
};
