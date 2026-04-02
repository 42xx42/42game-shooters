module.exports = {
  apps: [
    {
      name: '42game-shooters',
      script: './server.mjs',
      cwd: '/www/wwwroot/42game-shooters',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '4173',
        BASE_URL: 'https://your-domain.com',
        LINUX_DO_CLIENT_ID: '',
        LINUX_DO_CLIENT_SECRET: '',
        LINUX_DO_SCOPE: 'read',
        LINUX_DO_TOKEN_URL: '',
        LINUX_DO_USER_URL: '',
        ADMIN_LINUX_DO_USERNAMES: 'your_linux_do_username'
      }
    }
  ]
};
