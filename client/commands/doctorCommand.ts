import vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

export function generateDoctorCommand(client: LanguageClient) {
  return async () => {
    const isCoffeeFile = vscode?.window?.activeTextEditor?.document?.fileName?.endsWith('.coffee') || vscode?.window?.activeTextEditor?.document?.fileName?.endsWith('.coffee2')

    if (!vscode.window.activeTextEditor || !isCoffeeFile) {
      return vscode.window.showInformationMessage('Failed to showGeneratedJavascript. Make sure the current file is a .coffee file.');
    }

    const fileName = vscode.window.activeTextEditor.document.fileName;

    const result = (await client.sendRequest('$/doctor', { fileName })) as string;
    const showText = result.slice(0, 1000) + '....';
    const action = await vscode.window.showInformationMessage(showText, { modal: true }, 'Ok', 'Copy');
    if (action === 'Copy') {
      await vscode.env.clipboard.writeText(result);
    }
  };
}
