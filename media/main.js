// convey webview script: validation, shape math, canvas drawing

const MAX_GRID_SIDE = 64; // above this grids become a solid rectangle
const MAX_CELL_SIZE = 16; // in px
const MIN_CELL_SIZE = 3; // in px
const MIN_KERNEL_PX = 3; // scaled kernel smaller than this is not drawn
const MIN_OVERVIEW_PX = 4; // minimum visual thickness for extreme aspect ratios in overview mode
const SWEEP_DURATION_MS = 4500; // duration at 1.0x speed
const GAP_COLUMNS = 3; // spacing between the two grids, in cells

// using transparency everywhere so it looks readable on all themes
const COLOR_KERNEL = 'rgba(60, 140, 255, 0.6)';
const COLOR_KERNEL_ON_PADDING = 'rgba(25, 80, 200, 0.85)';
const COLOR_UNREACHED = 'rgba(255, 70, 70, 0.5)';
const COLOR_UNREACHED_ON_PADDING = 'rgba(170, 20, 20, 0.8)';

const PARAM_DEFINITIONS = {
    width: { label: 'WIDTH', min: 1, max: 9999, defaultValue: '16' },
    height: { label: 'HEIGHT', min: 1, max: 9999, defaultValue: '16' },
    inChannels: { label: 'in_channels', min: 1, max: 9999, defaultValue: '3', optional: true },
    outChannels: { label: 'out_channels', min: 1, max: 9999, defaultValue: '64', optional: true },
    bias: { label: 'Bias', min: 0, max: 1, defaultValue: '1', optional: true },
};

// each conv option exists once per axis: kernelHeight, kernelWidth, strideHeight, ...
for (const [prefix, label, min, defaultValue] of [
    ['kernel', 'kernel_size', 1, '3'],
    ['stride', 'stride', 1, '1'],
    ['padding', 'padding', 0, '0'],
    ['dilation', 'dilation', 1, '1'],
]) {
    PARAM_DEFINITIONS[`${prefix}Height`] = { label: `${label} (height)`, min, max: 999, defaultValue };
    PARAM_DEFINITIONS[`${prefix}Width`] = { label: `${label} (width)`, min, max: 999, defaultValue };
}

// undefined if previewed in a normal browser
const vscodeApi = typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : undefined;

const byId = (id) => document.getElementById(id);
const inputCanvas = byId('inputCanvas');
const outputCanvas = byId('outputCanvas');
const gridsElement = byId('grids');
const errorsElement = byId('errors');
const kernelNote = byId('kernelNote');
const details = byId('details');
const summary = byId('summary');
const warnRedCells = byId('warning');
const warnRedCellsText = byId('warningText');
const inputCaption = byId('inputCaption');
const outputCaption = byId('outputCaption');
const outputWidthLabel = byId('outputWidth');
const outputHeightLabel = byId('outputHeight');
const playButton = byId('playButton');
const speedSlider = byId('speedSlider');
const resetButton = byId('resetButton');
const sweepControls = byId('sweepControls');
const parameterSummary = byId('parameterSummary');
const channelsError = byId('channelsError');

const paramInputs = {};
const paramInputsKeys = Object.keys(PARAM_DEFINITIONS);

for (let i = 0; i < paramInputsKeys.length; i++) {
    const name = paramInputsKeys[i];
    const def = PARAM_DEFINITIONS[name];
    const el = document.querySelector(`[data-param="${name}"]`);
    
    paramInputs[name] = el;
    el.maxLength = String(def.max).length;
    el.inputMode = 'numeric';
    el.spellcheck = false;
    el.setAttribute('aria-label', def.label);
}

let layout = null; // set by render(), null when nothing can be drawn
let activeOutputRow = 0; // output cell whose kernel footprint is shown
let activeOutputCol = 0;
let sweepFrameId = 0;
let resizeFrameId = 0;

function readParams() {
    const values = {};
    const errorMessages = [];

    for (const [name, definition] of Object.entries(PARAM_DEFINITIONS)) {
        const input = paramInputs[name];
        const text = input.value.trim();
        const number = Number(text);
        const isValid = text !== '' && number >= definition.min && number <= definition.max;

        input.classList.toggle('invalid', !isValid);

        if (isValid) {
            values[name] = number;
        
        // optional params never block the grids
        } else if (!definition.optional) {
            errorMessages.push(`${definition.label} must be a whole number from ${definition.min} to ${definition.max}`);
        }
    }
    return { values, errorMessages };
}

function saveState() {
    if (!vscodeApi) {
        return;
    }

    const state = { speed: speedSlider.value };
    for (const name of paramInputsKeys) {
        state[name] = paramInputs[name].value;
    }
    vscodeApi.setState(state);
}

// math-related:

// uses formula O = ((I - K + 2P) / S) + 1
function computeAxis(inputSize, kernelSize, stride, padding, dilation) {
    const paddedSize = inputSize + 2 * padding; // "I + 2P"

    // dilation spreads the cells apart
    const effectiveKernel = dilation * (kernelSize - 1) + 1;

    // if negative, the kernel doesn't fit in the grid
    const span = paddedSize - effectiveKernel; // "I - K + 2P"

    const axis = {
        paddedSize,
        kernelSize,
        stride,
        padding,
        dilation,
        outputSize: 0
    };

    if (span >= 0) {
        // "... / S) + 1"
        axis.outputSize = Math.floor(span / stride) + 1;
    }
    return axis;
}

// padded positions the kernel touches for one output index (ascending)
function tapPositions(axis, outputIndex) {
    const positions = [];
    for (let tap = 0; tap < axis.kernelSize; tap++) {
        positions.push(outputIndex * axis.stride + tap * axis.dilation);
    }
    return positions;
}

// flags[position] = 1 if any output index touches that padded position
// a cell is reached only if its row AND its column are reached (footprints are row set x column set)
function reachedPositions(axis) {
    const flags = new Uint8Array(axis.paddedSize);
    let count = 0;
    for (let outputIndex = 0; outputIndex < axis.outputSize; outputIndex++) {
        for (const position of tapPositions(axis, outputIndex)) {
            if (flags[position] === 0) {
                flags[position] = 1;
                count++;
            }
        }
    }
    return { flags, count };
}

// drawing:

// this is a function and not a const to support
// theme changing while the webview is rendered
function foregroundColor() {
    return getComputedStyle(document.body).getPropertyValue('--text').trim();
}

function prepareCanvas(canvas, cssWidth, cssHeight) {
    const pixelRatio = window.devicePixelRatio || 1;

    const pixelWidth = Math.ceil(cssWidth * pixelRatio);
    const pixelHeight = Math.ceil(cssHeight * pixelRatio);

    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    // set width/height (clears canvas, allocates bitmap)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight)
    {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
    }

    const context = canvas.getContext('2d'); // TODO as global?
    context.reset();
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    return context;
}

// TODO: during playSweep, only the active cell moves, so redrawing the whole grid and grid lines every frame is redundant
function drawGrid(canvas, rowCount, colCount, cellSize, getCellPaint) {
    const gridWidth = colCount * cellSize;
    const gridHeight = rowCount * cellSize;

    // +1 px fixes the lines on the bottom and right not being rendered
    const context = prepareCanvas(canvas, gridWidth + 1, gridHeight + 1);

    for (let row = 0; row < rowCount; row++) {
        for (let col = 0; col < colCount; col++) {
            // returns { color, alpha? } or null for an empty cell
            const paint = getCellPaint(row, col);
            if (!paint) {
                continue;
            }

            context.globalAlpha = paint.alpha ?? 1;
            context.fillStyle = paint.color;
            context.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
        }
    }

    context.globalAlpha = 0.25;
    context.strokeStyle = foregroundColor();
    context.lineWidth = 1;
    context.beginPath();

    for (let row = 0; row <= rowCount; row++) {
        context.moveTo(0, row * cellSize + 0.5);
        context.lineTo(gridWidth + 1, row * cellSize + 0.5);
    }

    for (let col = 0; col <= colCount; col++) {
        context.moveTo(col * cellSize + 0.5, 0);
        context.lineTo(col * cellSize + 0.5, gridHeight + 1);
    }

    context.stroke();
    context.globalAlpha = 1;
}

// cells too big to render, so a rect is rendered instead
// NOTE: extreme aspect ratios (e.g. 1 x 9999) compress the thin side below 1px, so we clamp to MIN_OVERVIEW_PX
function drawOverviewBase(canvas, width, height) {
    const drawWidth = Math.max(width, MIN_OVERVIEW_PX);
    const drawHeight = Math.max(height, MIN_OVERVIEW_PX);
    const context = prepareCanvas(canvas, drawWidth, drawHeight);

    context.fillStyle = foregroundColor();
    context.strokeStyle = foregroundColor();
    context.globalAlpha = 0.1;
    context.fillRect(0, 0, drawWidth, drawHeight);

    context.globalAlpha = 0.5;
    context.strokeRect(0.5, 0.5, drawWidth - 1, drawHeight - 1);

    context.globalAlpha = 1;
    return context;
}

function drawInput() {
    const { rowAxis, colAxis, reachedRows, reachedCols, inputScale } = layout;

    const footprintRows = tapPositions(rowAxis, activeOutputRow);
    const footprintCols = tapPositions(colAxis, activeOutputCol);

    if (layout.inputIsOverview) {
        const width = colAxis.paddedSize * inputScale;
        const height = rowAxis.paddedSize * inputScale;
        const context = drawOverviewBase(inputCanvas, width, height);

        // padding ring = whole rectangle minus the inner image rectangle
        const paddingX = colAxis.padding * inputScale;
        const paddingY = rowAxis.padding * inputScale;

        context.globalAlpha = 0.2;
        context.fillStyle = foregroundColor();
        context.beginPath();
        context.rect(0, 0, width, height);
        context.rect(paddingX, paddingY, width - 2 * paddingX, height - 2 * paddingY);
        context.fill('evenodd');
        context.globalAlpha = 1;

        // kernel drawn as a rect (dilation isn't shown)
        const kernelX = footprintCols[0] * inputScale;
        const kernelY = footprintRows[0] * inputScale;

        const kernelWidth = (footprintCols[footprintCols.length - 1] - footprintCols[0] + 1) * inputScale;
        const kernelHeight = (footprintRows[footprintRows.length - 1] - footprintRows[0] + 1) * inputScale;

        const tooSmall = kernelWidth < MIN_KERNEL_PX || kernelHeight < MIN_KERNEL_PX;

        if (!tooSmall) {
            kernelNote.textContent = '';

            context.fillStyle = COLOR_KERNEL;
            context.fillRect(kernelX, kernelY, kernelWidth, kernelHeight);
        } else {
            kernelNote.textContent = 'Kernel is too small to draw at this scale.';
        }

        return;
    }

    // render grid normally:

    const footprintRowSet = new Set(footprintRows);
    const footprintColSet = new Set(footprintCols);
    const foreground = foregroundColor();

    drawGrid(inputCanvas, rowAxis.paddedSize, colAxis.paddedSize, inputScale, (row, col) => {
        const isPadding =
            row < rowAxis.padding || row >= rowAxis.paddedSize - rowAxis.padding ||
            col < colAxis.padding || col >= colAxis.paddedSize - colAxis.padding;

        if (footprintRowSet.has(row) && footprintColSet.has(col)) {
            return { color: isPadding ? COLOR_KERNEL_ON_PADDING : COLOR_KERNEL };
        }

        if (!reachedRows.flags[row] || !reachedCols.flags[col]) {
            return { color: isPadding ? COLOR_UNREACHED_ON_PADDING : COLOR_UNREACHED };
        }

        // if padding apply a slightly different color variation
        return isPadding ? { color: foreground, alpha: 0.18 } : null;
    });
}

function drawOutput() {
    const { rowAxis, colAxis, outputScale } = layout;

    if (layout.outputIsOverview) {
        const context = drawOverviewBase(
            outputCanvas,
            colAxis.outputSize * outputScale,
            rowAxis.outputSize * outputScale
        );

        const markerSize = Math.max(outputScale, MIN_KERNEL_PX);

        context.fillStyle = COLOR_KERNEL;
        context.fillRect(activeOutputCol * outputScale, activeOutputRow * outputScale, markerSize, markerSize);
        return;
    }

    drawGrid(outputCanvas, rowAxis.outputSize, colAxis.outputSize, outputScale, (row, col) => {
        const isActive = row === activeOutputRow && col === activeOutputCol;
        // fill with color kernel or none
        return isActive ? { color: COLOR_KERNEL } : null;
    });
}

function drawAll() {
    if (!layout) {
        return;
    }

    drawInput();
    drawOutput();
}

function hideGrids() {
    layout = null;
    gridsElement.hidden = true;
    sweepControls.hidden = true;
}

function strongText(text) {
    const el = document.createElement('strong');
    el.textContent = text;
    return el;
}

function render() {
    stopSweep();
    saveState();

    const { values, errorMessages } = readParams();
    errorsElement.textContent = errorMessages.join('\n');

    outputWidthLabel.textContent = '';
    outputHeightLabel.textContent = '';
    parameterSummary.replaceChildren();
    parameterSummary.hidden = true;
    channelsError.hidden = true;

    if (errorMessages.length > 0) {
        details.hidden = true;
        kernelNote.textContent = ''; // hide until all errors were fixed
        hideGrids();
        return;
    }

    const rowAxis = computeAxis(values.height, values.kernelHeight, values.strideHeight, values.paddingHeight, values.dilationHeight);
    const colAxis = computeAxis(values.width, values.kernelWidth, values.strideWidth, values.paddingWidth, values.dilationWidth);
    
    outputHeightLabel.textContent = `→ ${rowAxis.outputSize}`;
    outputWidthLabel.textContent = `→ ${colAxis.outputSize}`;
    details.hidden = false;

    if (rowAxis.outputSize === 0 || colAxis.outputSize === 0) {
        summary.textContent = 'Output: none (kernel is bigger than input)';

        warnRedCells.hidden = true;
        hideGrids();
        return;
    }

    // for padding, see below
    const widthDigits = Math.max(String(values.width).length, String(colAxis.outputSize).length);
    const heightDigits = Math.max(String(values.height).length, String(rowAxis.outputSize).length);
    
    // for text padding
    function pad(value, size) {
        return String(value).padEnd(size);
    }

    // NOTE: in pytorch docs, "B" is usually referred to as "N" (n of samples)
    // but I rather keep it "B" for "Batch Size", it is the same exact thing:
    const inputShape = `(B, ${values.inChannels ?? 'C_in'}, ${values.height}, ${values.width})`;
    const outputShape = `(B, ${values.outChannels ?? 'C_out'}, ${rowAxis.outputSize}, ${colAxis.outputSize})`;
    // ^^^ there isn't a real reason padding was avoided above, it just feels extra

    const inputText  = `${pad(values.width, widthDigits)} x ${pad(values.height, heightDigits)}`;
    const outputText = `${pad(colAxis.outputSize, widthDigits)} x ${pad(rowAxis.outputSize, heightDigits)}`;

    summary.replaceChildren(
        'Input:  ', strongText(inputText), ' — Shape: ', strongText(inputShape), '\n',
        'Output: ', strongText(outputText), ' — Shape: ', strongText(outputShape)
    );

    // secondary details (parameters, nn flatten):
    if (values.inChannels !== undefined && values.outChannels !== undefined && values.bias !== undefined) {
        const weightsPerFilter = values.inChannels * values.kernelHeight * values.kernelWidth;
        const parameterCount = values.outChannels * (weightsPerFilter + values.bias);
        const flattenedSize = values.outChannels * rowAxis.outputSize * colAxis.outputSize;

        parameterSummary.replaceChildren(
            'Parameters: C_out x (C_in x kH x kW + Bias)\n',
            `             = ${values.outChannels} x (${values.inChannels} x ${values.kernelHeight} x ${values.kernelWidth} + ${values.bias}) = `,
            strongText(String(parameterCount)),
            '\n\n',
            'nn.Flatten(): C_out x H_out x W_out\n',
            `             = ${values.outChannels} x ${rowAxis.outputSize} x ${colAxis.outputSize} = `,
            strongText(String(flattenedSize))
        );

        parameterSummary.hidden = false;
        channelsError.hidden = true;
    } else {
        // invalid optional params (C_in, C_out, Bias) hide parameterSummary but keep #summary visible
        parameterSummary.hidden = true;
        channelsError.hidden = false;
    }

    const reachedRows = reachedPositions(rowAxis);
    const reachedCols = reachedPositions(colAxis);

    const unreachedRowCount = rowAxis.paddedSize - reachedRows.count;
    const unreachedColCount = colAxis.paddedSize - reachedCols.count;

    // if any unreached cells exist:
    // NOTE: in overview mode (paddedSize > MAX_GRID_SIDE), red cells are not drawn individually even though this warning mentions them
    if (unreachedRowCount > 0 || unreachedColCount > 0) {
        warnRedCells.hidden = false;

        warnRedCellsText.textContent =
            `Cells drawn red are never reached by the kernel (${unreachedRowCount} rows, ${unreachedColCount} columns), ` +
            'those pixels never influence the output.';

    } else {
        warnRedCells.hidden = true;
    }

    // calc size of one cell:
    const availableWidth = document.body.clientWidth - 2 * 16;

    const shownColumns =
        Math.min(colAxis.paddedSize, MAX_GRID_SIDE) +
        Math.min(colAxis.outputSize, MAX_GRID_SIDE) +
        GAP_COLUMNS;

    const cellSize = clamp(
        Math.floor(availableWidth / shownColumns),
        MIN_CELL_SIZE,
        MAX_CELL_SIZE
    );

    const overviewBoxSize = MAX_GRID_SIDE * cellSize;

    const inputIsOverview = rowAxis.paddedSize > MAX_GRID_SIDE || colAxis.paddedSize > MAX_GRID_SIDE;
    const outputIsOverview = rowAxis.outputSize > MAX_GRID_SIDE || colAxis.outputSize > MAX_GRID_SIDE;

    layout = {
        rowAxis, colAxis, reachedRows, reachedCols, inputIsOverview, outputIsOverview,
        inputScale: inputIsOverview ? overviewBoxSize / Math.max(rowAxis.paddedSize, colAxis.paddedSize) : cellSize,
        outputScale: outputIsOverview ? overviewBoxSize / Math.max(rowAxis.outputSize, colAxis.outputSize) : cellSize,
    };

    activeOutputRow = Math.min(activeOutputRow, rowAxis.outputSize - 1);
    activeOutputCol = Math.min(activeOutputCol, colAxis.outputSize - 1);

    gridsElement.hidden = false;
    sweepControls.hidden = false;

    // if padding
    const paddedCaption = rowAxis.padding > 0 || colAxis.padding > 0 ?
        ` (with padding: ${colAxis.paddedSize} x ${rowAxis.paddedSize})` : '';

    inputCaption.textContent = `Input: ${values.width} x ${values.height}${paddedCaption}`;
    outputCaption.textContent = `Output: ${colAxis.outputSize} x ${rowAxis.outputSize}`;
    
    drawAll();
}

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

function setActiveOutputCell(row, col) {
    if (!layout) {
        return;
    }

    const newRow = clamp(row, 0, layout.rowAxis.outputSize - 1);
    const newCol = clamp(col, 0, layout.colAxis.outputSize - 1);

    // mousemove fires far more often than the cell changes, so skip redraw
    if (newRow === activeOutputRow && newCol === activeOutputCol) {
        return;
    }

    activeOutputRow = newRow;
    activeOutputCol = newCol;

    drawAll();
}

function cellUnderMouse(canvas, event, scale) {
    const bounds = canvas.getBoundingClientRect();
    return {
        row: Math.floor((event.clientY - bounds.top) / scale),
        col: Math.floor((event.clientX - bounds.left) / scale),
    };
}

outputCanvas.addEventListener('mousemove', (event) => {
    if (!layout) {
        return;
    }

    stopSweep();
    const cell = cellUnderMouse(outputCanvas, event, layout.outputScale);
    setActiveOutputCell(cell.row, cell.col);
});

// hovering the input picks the output cell whose window starts around that cell
inputCanvas.addEventListener('mousemove', (event) => {
    if (!layout) {
        return;
    }

    stopSweep();
    const cell = cellUnderMouse(inputCanvas, event, layout.inputScale);
    setActiveOutputCell(
        Math.floor(cell.row / layout.rowAxis.stride),
        Math.floor(cell.col / layout.colAxis.stride),
    );
});

function stopSweep() {
    cancelAnimationFrame(sweepFrameId);
}

function playSweep() {
    if (!layout) {
        return;
    }

    stopSweep();
    const outputColumns = layout.colAxis.outputSize;
    const totalPositions = layout.rowAxis.outputSize * outputColumns;
    const durationMs = SWEEP_DURATION_MS / Number(speedSlider.value); // read once per sweep
    const startTime = performance.now();

    function step(now) {
        const progress = Math.min((now - startTime) / durationMs, 1);
        const index = Math.min(Math.floor(progress * totalPositions), totalPositions - 1);
        setActiveOutputCell(Math.floor(index / outputColumns), index % outputColumns);

        if (progress < 1) {
            sweepFrameId = requestAnimationFrame(step);
        }
    }
    sweepFrameId = requestAnimationFrame(step);
}

playButton.addEventListener('click', playSweep);
speedSlider.addEventListener('input', saveState);

resetButton.addEventListener('click', () => {
    for (const [name, definition] of Object.entries(PARAM_DEFINITIONS)) {
        paramInputs[name].value = definition.defaultValue;
    }
    render();
});

window.addEventListener('resize', () => {
    // resize fires many times per frame while dragging, so render at most once per frame
    cancelAnimationFrame(resizeFrameId); // stop anim
    resizeFrameId = requestAnimationFrame(render);
});

// extension -> webview: parameters parsed from the Conv2d call under the cursor
window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type !== 'setParams') {
        return;
    }

    for (const [name, value] of Object.entries(message.params)) {
        if (paramInputs[name]) {
            paramInputs[name].value = String(value);
        }
    }
    render();
});

function initialize() {
    const savedState = vscodeApi ? vscodeApi.getState() : undefined;
    speedSlider.value = savedState?.speed ?? '2';

    for (const [name, definition] of Object.entries(PARAM_DEFINITIONS)) {
        const input = paramInputs[name];
        input.value = savedState?.[name] ?? definition.defaultValue;

        input.addEventListener('input', () => {
            // bias only allows 0 or 1; other params allow digits only
            const pattern = name === 'bias' ? /[^01]/g : /\D/g;
            const adjusted = input.value.replace(pattern, '');

            if (adjusted !== input.value) {
                input.value = adjusted;
            }
            render();
        });
    }
    render();
    if (vscodeApi) {
        vscodeApi.postMessage({ type: 'ready' }); // tells the extension it can send params now
    }
}

initialize();