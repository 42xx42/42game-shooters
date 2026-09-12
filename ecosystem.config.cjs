  module.exports = {
    apps: [
      {
        name: 'shooters-main',
        script: './server.mjs',
        cwd: '/www/wwwroot/shooters-main',
        interpreter: 'node',
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        watch: false,
        max_memory_restart: '512M',
          env: {
        NODE_ENV: 'production',
        MIN_REWARDABLE_MATCH_SECONDS: '45',
        HOST: '127.0.0.1',
        PORT: '4173',
        BASE_URL: 'https://game.42w.shop',
        LINUX_DO_CLIENT_ID: '', // 同上,
        LINUX_DO_CLIENT_SECRET: '',
        LINUX_DO_SCOPE: 'read',
        LINUX_DO_TOKEN_URL: '',
        LINUX_DO_USER_URL: '',
        ADMIN_LINUX_DO_USERNAMES: '4242',
        ALLOW_CLIENT_REPORTED_AWARDS: 'false', // 2026-09-12 反滥用：强制服务端见证,
        NEWAPI_BASE_URL: 'http://127.0.0.1:3000',
        NEWAPI_ADMIN_ACCESS_TOKEN: '', // 在服务器上通过私有环境注入,
        NEWAPI_ADMIN_USER_ID: '1',
        NEWAPI_TOPUP_MYSQL_CONTAINER: 'newapi_4242-mysql-1',
        NEWAPI_TOPUP_DB_NAME: 'new-api',
        NEWAPI_TOPUP_DB_USER: 'root',
        NEWAPI_TOPUP_DB_PASSWORD: '', // 同上,
        NEWAPI_TOPUP_PAYMENT_METHOD: 'Game Reward',
        NEWAPI_TOPUP_PAYMENT_PROVIDER: 'shooters-main',
        }
      }
    ]
  };