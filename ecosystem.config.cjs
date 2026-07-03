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
  }, {
    // Public announcements (mints/upgrades/sales) — exits immediately unless
    // TELEGRAM_ANNOUNCE_CHAT is set, so it's safe to keep in the app list.
    name: 'gumball-announcer',
    script: 'scripts/announcer.cjs',
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    stop_exit_codes: [0],   // clean exit (unconfigured) is not restarted
    max_memory_restart: '100M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/announcer-error.log',
    out_file: 'logs/announcer-out.log',
    env: {
      TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || '',
      TELEGRAM_ANNOUNCE_CHAT: process.env.TELEGRAM_ANNOUNCE_CHAT || '',
    },
  }]
};
