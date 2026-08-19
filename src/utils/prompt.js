import inquirer from 'inquirer';

export async function promptUser(questions) {
  const answers = await inquirer.prompt(questions);
  const requestedExit = questions.some(question => {
    if (!['input', 'password', 'editor'].includes(question.type)) return false;
    const value = answers[question.name];
    return typeof value === 'string' && ['exit', 'quit', '退出'].includes(value.trim().toLowerCase());
  });
  if (requestedExit) {
    const error = new Error('用户要求保存进度并退出');
    error.code = 'DEPLOY_PAUSE';
    throw error;
  }
  return answers;
}
