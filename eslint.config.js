module.exports = [
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        alert: 'readonly',
        chrome: 'readonly',
        currentLang: 'writable',
        checkingIds: 'readonly',
        drag: 'writable',
        suppressClick: 'writable',
        activeSiteCount: 'writable',
        TRANSLATIONS: 'readonly',
        MAX_SITES: 'readonly',
        DEFAULT_FREQ_INDEX: 'readonly',
        SUMMARY_HIDE_MS: 'readonly',
        AUTOSCROLL_ZONE_PX: 'readonly',
        AUTOSCROLL_SPEED_PX: 'readonly',
        DRAG_THRESHOLD_PX: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'eqeqeq': ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-implicit-globals': 'error',
      'no-var': 'error',
      'prefer-const': 'warn'
    }
  }
];