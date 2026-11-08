import * as vscode from 'vscode';

const OPEN_VIEW_CMD = 'convey.open';
const OPEN_FROM_CURSOR_CMD = 'convey.openFromCursor';
const VIEW_ID = 'conveyVisualizer'; // must match onWebviewPanel in package.json activationEvents
const VIEW_NAME = 'Convey';

const CONV2D_CALL_PATTERN = /\bConv2d\s*\(/; // \b so that LazyConv2d( is not matched
const MAX_CALL_LINES = 10; // how far below the first line the closing parenthesis is searched

// keys should match PARAM_DEFINITIONS in main.js
type ConvParams = Record<string, string>;

// torch.nn.Conv2d positional order: in_channels, out_channels, kernel_size, stride, padding, dilation
// the two channel entries have no matching param, they only keep the positions right
const POSITIONAL_NAMES = ['inChannels', 'outChannels', 'kernelSize', 'stride', 'padding', 'dilation'];
const KEYWORD_TO_PARAM: Record<string, string> = {
    kernel_size: 'kernelSize',
    stride: 'stride',
    padding: 'padding',
    dilation: 'dilation',
};
const PARAM_PREFIX: Record<string, string> = {
    kernelSize: 'kernel',
    stride: 'stride',
    padding: 'padding',
    dilation: 'dilation',
};

// pytorch defaults, used when an argument is missing or is not a plain number
// TODO: padding='same' is treated as 0 for now
const CONV2D_DEFAULTS: ConvParams = {
    strideHeight: '1',
    strideWidth: '1',
    paddingHeight: '0',
    paddingWidth: '0',
    dilationHeight: '1',
    dilationWidth: '1',
};

let currentPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand(OPEN_VIEW_CMD, () => showPanel(context)),

        vscode.commands.registerCommand(
            OPEN_FROM_CURSOR_CMD,
            (lineNumber?: unknown) => openFromLine(context, lineNumber)
        ),

        vscode.languages.registerCodeLensProvider({ language: 'python' }, new Conv2dCodeLensProvider()),

        vscode.window.registerWebviewPanelSerializer(VIEW_ID, {
            // called for a panel that was open last session
            async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
                await setupPanel(context, panel);
            }
        })
    );
}

export function deactivate() {}

// "Visualize in Convey" link above every line that contains "Conv2d"
class Conv2dCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const codeLenses: vscode.CodeLens[] = [];

        for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
            const lineText = document.lineAt(lineNumber).text;

            // shallow checks:
            if (!(lineText.includes('Conv2d') && !lineText.trimStart().startsWith('#'))) {
                continue;
            }
            
            if (!CONV2D_CALL_PATTERN.test(lineText)) {
                continue;
            }

            const lineStart = new vscode.Range(lineNumber, 0, lineNumber, 0);
            codeLenses.push(new vscode.CodeLens(lineStart, {
                title: 'Visualize in Convey',
                command: OPEN_FROM_CURSOR_CMD,
                arguments: [lineNumber],
            }));
        }
        return codeLenses;
    }
}

async function openFromLine(context: vscode.ExtensionContext, lineNumber?: unknown) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        await showPanel(context);
        return;
    }

    // the code lens passes a line number, the context menu passes a uri, the palette passes nothing
    const targetLine = typeof lineNumber === 'number'
        ? lineNumber
        : editor.selection.active.line;

    const argumentsText = extractConv2dArguments(editor.document, targetLine);
    if (argumentsText === undefined) {
        vscode.window.showWarningMessage('Convey: no complete Conv2d(...) call found on this line.');
        await showPanel(context);
        return;
    }
    await showPanel(context, parseConv2dArguments(argumentsText));
}

async function showPanel(context: vscode.ExtensionContext, params?: ConvParams) {
    if (currentPanel) {
        currentPanel.reveal(undefined, true); // keep column, keep editor focus
        if (params) {
            currentPanel.webview.postMessage({ type: 'setParams', params });
        }
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        VIEW_ID,
        VIEW_NAME,
        vscode.ViewColumn.Beside
    );
    
    await setupPanel(context, panel, params);
}

async function setupPanel(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    initialParams?: ConvParams
) {
    currentPanel = panel;
    panel.onDidDispose(() => {
        currentPanel = undefined;
    });

    // sent on the first 'ready' only, later reloads of the webview restore from its saved state
    let paramsToSend = initialParams;

    // set listener before html, so the 'ready' message can never be missed
    panel.webview.onDidReceiveMessage((message) => {
        if (message.type === 'ready' && paramsToSend) {
            panel.webview.postMessage({ type: 'setParams', params: paramsToSend });
            paramsToSend = undefined;
        }
    });

    panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    };
    panel.webview.html = await getWebviewHtml(context, panel.webview);
}

async function getWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): Promise<string> {
    const mediaFolder = vscode.Uri.joinPath(context.extensionUri, 'media');
    const htmlBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(mediaFolder, 'index.html'));
    const html = new TextDecoder('utf-8').decode(htmlBytes);

    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaFolder, 'style.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaFolder, 'main.js'));

    // block everything except the extension's own css and js
    const contentSecurity = [
        `default-src 'none'`,
        `style-src ${webview.cspSource}`,
        `script-src ${webview.cspSource}`,
    ].join('; ');

    // index.html uses plain relative paths and has no CSP, so it also opens in a browser preview
    return html
        .replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${contentSecurity}">`)
        .replace('href="style.css"', `href="${cssUri}"`)
        .replace('src="main.js"', `src="${jsUri}"`);
}

// returns the text between the parentheses of the Conv2d( call on that line, can span a few lines
function extractConv2dArguments(document: vscode.TextDocument, lineNumber: number): string | undefined {
    if (lineNumber < 0 || lineNumber >= document.lineCount) {
        return undefined;
    }

    const firstLine = document.lineAt(lineNumber);
    const callMatch = CONV2D_CALL_PATTERN.exec(firstLine.text);
    if (!callMatch) {
        return undefined;
    }

    // only read the first line plus a few lines below it, not the whole file
    const lastLineNumber = Math.min(lineNumber + MAX_CALL_LINES, document.lineCount - 1);
    const searchRange = new vscode.Range(firstLine.range.start, document.lineAt(lastLineNumber).range.end);
    const text = document.getText(searchRange);

    // the range starts at the line start, so the match index is also an index into text
    const openParenIndex = callMatch.index + callMatch[0].length - 1;

    // count parentheses so "(in * 2)" inside an argument does not close the call early
    let depth = 0;
    for (let index = openParenIndex; index < text.length; index++) {
        const character = text[index];
        if (character === '(') {
            depth++;
        } else if (character === ')') {
            depth--;
            if (depth === 0) {
                return text.slice(openParenIndex + 1, index);
            }
        }
    }
    return undefined; // never closed
}

// split on commas that are not inside (), [] or {}
function splitTopLevelArguments(argumentsText: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';

    for (const character of argumentsText) {
        if ('([{'.includes(character)) {
            depth++;
        }
        if (')]}'.includes(character)) {
            depth--;
        }

        if (character === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
        } else {
            current += character;
        }
    }
    if (current.trim() !== '') {
        parts.push(current.trim());
    }
    return parts;
}

// "3" -> ['3', '3'], "(3, 5)" -> ['3', '5'] (height, width), anything else -> undefined
function parseIntegerPair(valueText: string): [string, string] | undefined {
    if (/^\d+$/.test(valueText)) {
        return [valueText, valueText];
    }
    const pairMatch = valueText.match(/^\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
    if (pairMatch) {
        return [pairMatch[1], pairMatch[2]];
    }
    return undefined;
}

function parseConv2dArguments(argumentsText: string): ConvParams {
    const params: ConvParams = { ...CONV2D_DEFAULTS };

    splitTopLevelArguments(argumentsText).forEach((part, position) => {
        // "stride = 2" and "stride=2" are keyword arguments, anything else is positional
        const keywordMatch = part.match(/^(\w+)\s*=\s*(.+)$/);
        const paramName: string | undefined = keywordMatch
            ? KEYWORD_TO_PARAM[keywordMatch[1]]
            : POSITIONAL_NAMES[position];
        const valueText = (keywordMatch ? keywordMatch[2] : part).trim();

        // unknown keyword (groups, bias, ...) or too many positional arguments
        const prefix = paramName ? PARAM_PREFIX[paramName] : undefined;
        if (!prefix) {
            return;
        }

        // not a plain number or pair (a variable, 'same', ...): keep the default
        const pair = parseIntegerPair(valueText);
        if (pair) {
            params[`${prefix}Height`] = pair[0];
            params[`${prefix}Width`] = pair[1];
        }
    });
    return params;
}