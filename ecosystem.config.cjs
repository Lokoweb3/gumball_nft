module.exports = {
  apps: [{
    name: 'gumball-oracle',
    script: 'scripts/oracle.cjs',
    watch: false,
    max_restarts: 50,
    restart_delay: 3000,    // wait 3s before restarting
    max_memory_restart: '200M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/oracle-error.log',
    out_file: 'logs/oracle-out.log',
  }, {
    name: 'gumball-monitor',
    script: 'scripts/monitor.cjs',
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: '100M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/monitor-error.log',
    out_file: 'logs/monitor-out.log',
    env: {
      TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || '',
      TELEGRAM_CHAT: process.env.TELEGRAM_CHAT || '529787973',
    },
  }]
};
