#!/usr/bin/env node
import { program } from 'commander';
import chalk from 'chalk';
import { createRequire } from 'module';
import { deployInit } from './commands/init.js';
import { deployUpdate, manageServers } from './commands/update.js';
import { deployStatus } from './commands/status.js';
import { deployRollback } from './commands/rollback.js';
import { deployEnv } from './commands/env.js';
import { deployBackup } from './commands/backup.js';
import { printPlatformSummary } from './utils/onboarding.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

printPlatformSummary();
console.log(chalk.cyan.bold('\n🚀 deploy-helper') + chalk.gray(` v${version} — 把项目部署到服务器，就这么简单\n`));

// Ctrl+C 中断 inquirer 交互时优雅退出，不显示堆栈
function onExitPromptError(err) {
  if (err && err.constructor?.name === 'ExitPromptError') {
    console.log(chalk.gray('\n已取消。\n'));
    process.exit(0);
  }
}
function printUnexpectedError(err) {
  console.error(chalk.red('\n发生未处理错误：') + (err?.message || String(err)));
  if (process.env.DEPLOY_HELPER_DEBUG === '1' && err?.stack) {
    console.error(chalk.gray(err.stack));
  } else {
    console.error(chalk.gray('设置 DEPLOY_HELPER_DEBUG=1 可查看完整堆栈。'));
  }
}
process.on('uncaughtException', (err) => {
  onExitPromptError(err);
  printUnexpectedError(err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  onExitPromptError(err);
  printUnexpectedError(err);
  process.exit(1);
});

program
  .name('deploy-helper')
  .description('交互式部署工具，帮你把项目从本地跑到任意 VPS 服务器上')
  .version(version);

program
  .command('init')
  .description('首次部署：引导你完成全套配置')
  .action(deployInit);

program
  .command('update')
  .description('更新部署：推送最新代码并重启（支持多服务器）')
  .action(deployUpdate);

program
  .command('status')
  .description('查看服务运行状态、内存占用、最近日志')
  .action(deployStatus);

program
  .command('rollback')
  .description('版本回滚：从历史快照中选择一个版本还原')
  .action(deployRollback);

program
  .command('env')
  .description('环境变量管理：上传/下载/对比 .env 文件')
  .action(deployEnv);

program
  .command('backup')
  .description('数据库备份：MySQL / PostgreSQL / MongoDB，支持定时任务')
  .action(deployBackup);

program
  .command('servers')
  .description('服务器管理：查看、添加、删除多台服务器')
  .action(manageServers);

// 无命令时显示帮助
if (process.argv.length === 2) {
  console.log(chalk.bold('可用命令：\n'));
  console.log(`  ${chalk.cyan('init')}      首次部署，全程引导`);
  console.log(`  ${chalk.cyan('update')}    推送新代码到服务器（支持多台）`);
  console.log(`  ${chalk.cyan('rollback')}  回滚到历史版本`);
  console.log(`  ${chalk.cyan('env')}       管理 .env 环境变量`);
  console.log(`  ${chalk.cyan('backup')}    数据库备份`);
  console.log(`  ${chalk.cyan('servers')}   管理多台服务器`);
  console.log(`  ${chalk.cyan('status')}    查看运行状态\n`);
  console.log(chalk.gray('首次使用？运行：') + chalk.cyan(' deploy-helper init\n'));
} else {
  try {
    await program.parseAsync();
  } catch (error) {
    if (error?.code === 'DEPLOY_PAUSE' || error?.constructor?.name === 'ExitPromptError') {
      console.log(chalk.yellow('\n已安全停止，当前部署进度已经保存。'));
      console.log(chalk.gray('下次运行 deploy-helper init 时，会询问是否继续。\n'));
      process.exitCode = 0;
    } else {
      printUnexpectedError(error);
      process.exitCode = 1;
    }
  }
}
