// ESLint v9 配置
const typescriptParser = require('@typescript-eslint/parser');
const typescriptPlugin = require('@typescript-eslint/eslint-plugin');
const prettierPlugin = require('eslint-plugin-prettier');

module.exports = [
  {
    ignores: [
      'src/frontend/**',
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '*.js',
    ],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        node: true,
        jest: true,
      },
    },
    plugins: {
      '@typescript-eslint': typescriptPlugin,
      prettier: prettierPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/harness/context/ContextManager'],
              message: 'ContextManager 已废弃(V6.0移除)，请使用 UnifiedContextPipeline + ConstitutionPromptBuilder',
            },
            {
              group: ['**/models/LLMProvider'],
              message: 'LLMProvider 已废弃(V6.0移除)，请使用 LLMProviderBridge',
            },
            {
              group: ['**/evolution/EvolutionOrchestrator'],
              message: 'EvolutionOrchestrator 已废弃(V6.0移除)，进化逻辑已迁移到 Python agent/evolution',
            },
            {
              group: ['**/memory/MemoryEngine'],
              message: 'MemoryEngine 已废弃(V6.0移除)，记忆逻辑已迁移到 Python agent/memory',
            },
            {
              group: ['**/harness/context/TokenBudgetAllocator'],
              message: 'TokenBudgetAllocator 已废弃(V6.0移除)，请使用 ContextWindowManager',
            },
            {
              group: ['**/harness/loop/*'],
              message: 'Loop 层已废弃(V6.0移除)，循环逻辑已迁移到 Python agent/loop',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'warn',
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='getInstance']",
          message: 'getInstance() 单例模式正在迁移到 DI 容器，新代码请使用 DIContainer.resolve(DI_TOKENS.XXX)',
        },
      ],
      'prettier/prettier': 'error',
    },
  },
];
