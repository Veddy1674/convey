import * as vscode from 'vscode';

const OPEN_VIEW_CMD = 'convey.open';
const OPEN_FROM_CURSOR_CMD = 'convey.openFromCursor';
const VIEW_ID = 'conveyVisualizer'; // must match onWebviewPanel in package.json activationEvents
const VIEW_NAME = 'Convey';

const CONV2D_CALL_PATTERN = /\bConv2d\s*\(/; // \b so that LazyConv2d( is not matched
const MAX_CALL_LINES = 8; // how far below the first line the closing parenthesis is searched

// keys should match PARAM_DEFINITIONS in main.js
type ConvParams = Record<string, string>;

// torch.nn.Conv2d positional order: in_channels, out_channels, kernel_size, stride, padding, dilation, groups, bias
// groups has no matching param, it only keeps the positional index of bias right
const POSITIONAL_NAMES = ['inChannels', 'outChannels', 'kernelSize', 'stride', 'padding', 'dilation', 'groups', 'bias'];
const KEYWORD_TO_PARAM: Record<string, string> = {
    in_channels: 'inChannels',
    out_channels: 'outChannels',
    kernel_size: 'kernelSize',
    stride: 'stride',
    padding: 'padding',
    dilation: 'dilation',
    bias: 'bias',
};
const PARAM_PREFIX: Record<string, string> = {
    kernelSize: 'kernel',
    stride: 'stride',
    padding: 'padding',
    dilation: 'dilation',
};

// pytorch defaults (plus 3/64 channels and 3x3 kernel), used when an argument is missing or is not a plain literal
// TODO: padding='same' is treated as 0 for now
const CONV2D_DEFAULTS: ConvParams = {
    inChannels: '3',
    outChannels: '64',
    bias: '1',
    kernelHeight: '3',
    kernelWidth: '3',
    strideHeight: '1',
    strideWidth: '1',
    paddingHeight: '0',
    paddingWidth: '0',
    dilationHeight: '1',
    dilationWidth: '1',
};

let currentPanel: vscode.WebviewPanel | undefined;
let isWebviewReady = false;
let pendingParams: ConvParams | undefined;

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
        // fast bailout before scanning line-by-line in files without Conv2d
        if (!document.getText().includes('Conv2d')) {
            return [];
        }

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
        if (params) {
            if (currentPanel.visible && isWebviewReady) {
                currentPanel.webview.postMessage({ type: 'setParams', params });
            } else {
                // hidden webviews reload when revealed, so queue params until 'ready' arrives
                isWebviewReady = false;
                pendingParams = params;
            }
        }
        currentPanel.reveal(undefined, true); // keep column, keep editor focus
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
    isWebviewReady = false;
    pendingParams = initialParams;

    let isDisposed = false;
    panel.onDidDispose(() => {
        isDisposed = true;
        currentPanel = undefined;
        isWebviewReady = false;
        pendingParams = undefined;
    });

    // without retainContextWhenHidden, hiding the tab tears down the webview and reloads it on reveal
    panel.onDidChangeViewState((event) => {
        if (!event.webviewPanel.visible) {
            isWebviewReady = false;
        }
    });

    // set listener before html, so the 'ready' message can never be missed
    panel.webview.onDidReceiveMessage((message) => {
        if (message?.type === 'ready') {
            isWebviewReady = true;
            if (pendingParams) {
                panel.webview.postMessage({ type: 'setParams', params: pendingParams });
                pendingParams = undefined;
            }
        }
    });

    panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    };

    const html = await getWebviewHtml(context, panel.webview);
    if (!isDisposed) {
        panel.webview.html = html;
    }
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
// NOTE: openFromCursor expects the cursor to be on the opening Conv2d( line, not on inner lines of a multi-line call!
// TODO: handle multi-line strings ("""...""" / '''...''') so ')' or '#' inside them does not affect parentheses matching
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
    let quote: string | undefined;

    for (let index = openParenIndex; index < text.length; index++) {
        const character = text[index];

        if (quote) {
            if (character === '\\') {
                index++; // skip escaped character
            } else if (character === quote) {
                quote = undefined;
            }
            continue;
        }

        if (character === '#') {
            // ignore the rest of the line so comments with ')' don't close the call early
            const newlineIndex = text.indexOf('\n', index);
            if (newlineIndex === -1) {
                break;
            }
            index = newlineIndex;
            continue;
        }

        if (character === '\'' || character === '"') {
            quote = character;
            continue;
        }

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

// split on commas that are not inside (), [] or {}, ignoring # comments and single-line strings
function splitTopLevelArguments(argumentsText: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    let quote: string | undefined;

    for (let index = 0; index < argumentsText.length; index++) {
        const character = argumentsText[index];

        if (quote) {
            current += character;
            if (character === '\\' && index + 1 < argumentsText.length) {
                index++;
                current += argumentsText[index];
            } else if (character === quote) {
                quote = undefined;
            }
            continue;
        }

        if (character === '#') {
            const newlineIndex = argumentsText.indexOf('\n', index);
            if (newlineIndex === -1) {
                break;
            }
            index = newlineIndex;
            continue;
        }

        if (character === '\'' || character === '"') {
            quote = character;
            current += character;
            continue;
        }

        if ('([{'.includes(character)) {
            depth++;
        } else if (')]}'.includes(character)) {
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

        if (!paramName) {
            return;
        }

        if (paramName === 'inChannels' || paramName === 'outChannels') {
            if (/^\d+$/.test(valueText)) {
                params[paramName] = valueText;
            }
            return;
        }

        if (paramName === 'bias') {
            if (valueText === 'False') {
                params.bias = '0';
            } else if (valueText === 'True') {
                params.bias = '1';
            }
            return;
        }

        // unknown keyword (groups, padding_mode, ...) or too many positional arguments
        const prefix = PARAM_PREFIX[paramName];
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