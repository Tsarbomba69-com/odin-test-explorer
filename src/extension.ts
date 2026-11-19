import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

interface TestMetadata {
    type: 'package' | 'file' | 'test';
    pkgDir: string;
    procName?: string;
}

const testMeta = new WeakMap<vscode.TestItem, TestMetadata>();

export function activate(context: vscode.ExtensionContext) {
    const controller = vscode.tests.createTestController('odinTestController', 'Odin Tests');
    context.subscriptions.push(controller);

    controller.refreshHandler = async () => {
        await discoverAllTests(controller);
    };

    controller.createRunProfile(
        'Run Odin Tests',
        vscode.TestRunProfileKind.Run,
        (request, token) => runTests(controller, request, token),
        true
    );

    controller.createRunProfile(
        'Debug Odin Tests',
        vscode.TestRunProfileKind.Debug,
        (request, token) => debugTests(controller, request, token)
    );

    // Watch for file creation, edits, and deletions
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.odin');
    watcher.onDidCreate(uri => discoverFile(controller, uri));
    watcher.onDidChange(uri => discoverFile(controller, uri));
    watcher.onDidDelete(uri => removeFileFromTree(controller, uri));
    context.subscriptions.push(watcher);

    // Also update live when an open document changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId === 'odin' || e.document.uri.fsPath.endsWith('.odin')) {
                parseAndPopulateFile(controller, e.document.uri, e.document.getText());
            }
        })
    );

    // Initial discovery
    discoverAllTests(controller);
}

async function discoverAllTests(controller: vscode.TestController): Promise<void> {
    controller.items.replace([]);
    const uris = await vscode.workspace.findFiles('**/*.odin', '**/node_modules/**');
    await Promise.all(uris.map(uri => discoverFile(controller, uri)));
}

async function discoverFile(controller: vscode.TestController, uri: vscode.Uri): Promise<void> {
    try {
        const raw = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(raw).toString('utf8');
        parseAndPopulateFile(controller, uri, text);
    } catch {
        removeFileFromTree(controller, uri);
    }
}

function parseAndPopulateFile(controller: vscode.TestController, uri: vscode.Uri, text: string): void {
    const pkgDir = path.dirname(uri.fsPath);
    const pkgId = `pkg:${pkgDir}`;
    const fileId = `file:${uri.toString()}`;

    const discovered = extractOdinTests(text);

    if (discovered.length === 0) {
        removeFileFromTree(controller, uri);
        return;
    }

    // Ensure package node exists
    let pkgItem = controller.items.get(pkgId);
    if (!pkgItem) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        const relPkgLabel = workspaceFolder
            ? path.relative(workspaceFolder.uri.fsPath, pkgDir) || workspaceFolder.name
            : path.basename(pkgDir);

        pkgItem = controller.createTestItem(pkgId, relPkgLabel, vscode.Uri.file(pkgDir));
        testMeta.set(pkgItem, { type: 'package', pkgDir });
        controller.items.add(pkgItem);
    }

    // Ensure file node exists under package
    let fileItem = pkgItem.children.get(fileId);
    if (!fileItem) {
        fileItem = controller.createTestItem(fileId, path.basename(uri.fsPath), uri);
        testMeta.set(fileItem, { type: 'file', pkgDir });
        pkgItem.children.add(fileItem);
    }

    // Populate test procedure items
    const nextTests: vscode.TestItem[] = [];
    for (const test of discovered) {
        const testId = `test:${uri.toString()}::${test.name}`;
        const testItem = controller.createTestItem(testId, test.name, uri);
        testItem.range = new vscode.Range(test.line, 0, test.line, test.endCol);
        testMeta.set(testItem, {
            type: 'test',
            pkgDir,
            procName: test.name,
        });
        nextTests.push(testItem);
    }

    fileItem.children.replace(nextTests);
}

function removeFileFromTree(controller: vscode.TestController, uri: vscode.Uri): void {
    const pkgDir = path.dirname(uri.fsPath);
    const pkgId = `pkg:${pkgDir}`;
    const fileId = `file:${uri.toString()}`;

    const pkgItem = controller.items.get(pkgId);
    if (!pkgItem) {
        return;
    }

    pkgItem.children.delete(fileId);
    if (pkgItem.children.size === 0) {
        controller.items.delete(pkgId);
    }
}

interface DiscoveredTest {
    name: string;
    line: number;
    endCol: number;
}

/**
 * Strips comments while preserving newline offsets so line numbers remain exact,
 * then matches `@(test)` or `@test` followed by `<name> :: proc(`.
 */
function extractOdinTests(source: string): DiscoveredTest[] {
    const sanitized = stripCommentsPreserveLines(source);
    const results: DiscoveredTest[] = [];

    // Matches:
    //   @test  OR  @(test)  OR  @(private, test)
    //   followed by whitespace/newlines and `proc_name :: proc(`
    const regex = /@(?:test\b|\([^)]*\btest\b[^)]*\))\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*::\s*proc\s*\(/g;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(sanitized)) !== null) {
        const procName = match[1];
        const procNameOffset = match.index + match[0].indexOf(procName);
        const before = sanitized.slice(0, procNameOffset);
        const line = before.split('\n').length - 1;
        const lastNewline = before.lastIndexOf('\n');
        const col = procNameOffset - (lastNewline + 1);

        results.push({
            name: procName,
            line,
            endCol: col + procName.length,
        });
    }

    return results;
}

function stripCommentsPreserveLines(src: string): string {
    let out = '';
    let i = 0;
    let blockDepth = 0;
    let inLineComment = false;
    let inString = false;
    let stringChar = '';

    while (i < src.length) {
        const ch = src[i];
        const next = src[i + 1];

        if (inLineComment) {
            if (ch === '\n') {
                inLineComment = false;
                out += '\n';
            } else {
                out += ' ';
            }
            i++;
            continue;
        }

        if (blockDepth > 0) {
            if (ch === '/' && next === '*') {
                blockDepth++;
                out += '  ';
                i += 2;
            } else if (ch === '*' && next === '/') {
                blockDepth--;
                out += '  ';
                i += 2;
            } else {
                out += ch === '\n' ? '\n' : ' ';
                i++;
            }
            continue;
        }

        if (inString) {
            out += ch;
            if (ch === '\\' && stringChar !== '`') {
                out += next ?? '';
                i += 2;
                continue;
            }
            if (ch === stringChar) {
                inString = false;
            }
            i++;
            continue;
        }

        if (ch === '"' || ch === '\'' || ch === '`') {
            inString = true;
            stringChar = ch;
            out += ch;
            i++;
            continue;
        }

        if (ch === '/' && next === '/') {
            inLineComment = true;
            out += '  ';
            i += 2;
            continue;
        }

        if (ch === '/' && next === '*') {
            blockDepth = 1;
            out += '  ';
            i += 2;
            continue;
        }

        out += ch;
        i++;
    }

    return out;
}

async function runTests(
    controller: vscode.TestController,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
): Promise<void> {
    const run = controller.createTestRun(request);
    const excludeSet = new Set(request.exclude ?? []);

    // Collect all leaf test items requested
    const leaves: vscode.TestItem[] = [];
    const collect = (item: vscode.TestItem) => {
        if (excludeSet.has(item)) {
            return;
        }
        const meta = testMeta.get(item);
        if (meta?.type === 'test') {
            leaves.push(item);
            run.enqueued(item);
        } else {
            item.children.forEach(child => collect(child));
        }
    };

    if (request.include && request.include.length > 0) {
        request.include.forEach(item => collect(item));
    } else {
        controller.items.forEach(item => collect(item));
    }

    // Group leaf tests by Odin package directory so each package compiles once
    const byPackage = new Map<string, vscode.TestItem[]>();
    for (const item of leaves) {
        const meta = testMeta.get(item)!;
        const list = byPackage.get(meta.pkgDir) ?? [];
        list.push(item);
        byPackage.set(meta.pkgDir, list);
    }

    const config = vscode.workspace.getConfiguration('odinTestExplorer');
    const odinPath = config.get<string>('odinPath', 'odin');
    const trackMemory = config.get<boolean>('trackMemory', true);
    const extraArgs = config.get<string[]>('extraArgs', []);

    for (const [pkgDir, items] of byPackage.entries()) {
        if (token.isCancellationRequested) {
            items.forEach(item => run.skipped(item));
            continue;
        }

        items.forEach(item => run.started(item));

        const testNames = items
            .map(i => testMeta.get(i)?.procName)
            .filter((n): n is string => Boolean(n));

        const args = [
            'test',
            pkgDir,
            '-define:ODIN_TEST_FANCY=false',
            `-define:ODIN_TEST_TRACK_MEMORY=${trackMemory}`,
            `-define:ODIN_TEST_NAMES=${testNames.join(',')}`,
            ...extraArgs,
        ];

        const startTime = Date.now();
        const result = await execOdin(odinPath, args, pkgDir, token);
        const duration = Date.now() - startTime;
        const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');

        // Stream raw output to VS Code's Test Results terminal
        run.appendOutput(combinedOutput.replace(/\r?\n/g, '\r\n') + '\r\n');

        // Parse per-test failures from Odin's test logger
        const failuresByProc = parseOdinTestErrors(combinedOutput, pkgDir);

        for (const item of items) {
            const procName = testMeta.get(item)?.procName ?? item.label;
            const procFailures = failuresByProc.get(procName);

            if (procFailures && procFailures.length > 0) {
                run.failed(item, procFailures, duration);
            } else if (result.exitCode !== 0 && failuresByProc.size === 0) {
                // Compilation error or test runner crash before individual test logging
                run.errored(item, new vscode.TestMessage(combinedOutput.trim() || 'odin test failed'), duration);
            } else {
                run.passed(item, duration);
            }
        }
    }

    run.end();
}

/**
 * Picks the debug adapter type. An explicit user/workspace setting always wins.
 * Otherwise use the adapter that can actually read the debug info Odin emits on
 * this platform: Odin writes a PDB on Windows, which the Visual Studio debugger
 * (`cppvsdbg`, from the C/C++ extension) binds breakpoints against reliably,
 * whereas CodeLLDB (`lldb`) frequently leaves them unbound. DWARF on Linux/macOS
 * works well with `lldb`.
 *
 * `inspect()` is used instead of `get()` so a default declared in package.json
 * does not mask the platform-specific choice.
 */
function resolveDebuggerType(config: vscode.WorkspaceConfiguration): string {
    const info = config.inspect<string>('debuggerType');
    const explicit = info?.workspaceFolderValue ?? info?.workspaceValue ?? info?.globalValue;
    if (explicit) {
        return explicit;
    }
    return process.platform === 'win32' ? 'cppvsdbg' : 'lldb';
}

/** Build selected tests without running them, then launch the executable through
 * a VS Code native debugger so source breakpoints bind to the test process. */
async function debugTests(
    controller: vscode.TestController,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
): Promise<void> {
    const run = controller.createTestRun(request);
    const excludeSet = new Set(request.exclude ?? []);
    const leaves: vscode.TestItem[] = [];
    const collect = (item: vscode.TestItem) => {
        if (excludeSet.has(item)) return;
        if (testMeta.get(item)?.type === 'test') {
            leaves.push(item);
            run.enqueued(item);
        } else {
            item.children.forEach(collect);
        }
    };
    if (request.include?.length) request.include.forEach(collect);
    else controller.items.forEach(collect);

    const byPackage = new Map<string, vscode.TestItem[]>();
    for (const item of leaves) {
        const pkgDir = testMeta.get(item)!.pkgDir;
        const group = byPackage.get(pkgDir) ?? [];
        group.push(item);
        byPackage.set(pkgDir, group);
    }

    const config = vscode.workspace.getConfiguration('odinTestExplorer');
    const odinPath = config.get<string>('odinPath', 'odin');
    const trackMemory = config.get<boolean>('trackMemory', true);
    const extraArgs = config.get<string[]>('extraArgs', []);
    const debuggerType = resolveDebuggerType(config);

    for (const [pkgDir, items] of byPackage) {
        if (token.isCancellationRequested) {
            items.forEach(item => run.skipped(item));
            continue;
        }
        items.forEach(item => run.started(item));

        const testNames = items.map(item => testMeta.get(item)?.procName).filter((name): name is string => !!name);
        let tempDir: string | undefined;
        try {
            tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'odin-test-explorer-'));
            const executable = path.join(tempDir, process.platform === 'win32' ? 'odin-tests.exe' : 'odin-tests');
            const args = [
                'build', pkgDir, '-build-mode:test', '-debug', '-o:none',
                `-out:${executable}`,
                '-define:ODIN_TEST_FANCY=false',
                `-define:ODIN_TEST_TRACK_MEMORY=${trackMemory}`,
                '-define:ODIN_TEST_THREADS=1',
                `-define:ODIN_TEST_NAMES=${testNames.join(',')}`,
                ...extraArgs,
            ];
            const build = await execOdin(odinPath, args, pkgDir, token);
            const buildOutput = [build.stdout, build.stderr].filter(Boolean).join('\n');
            if (buildOutput) run.appendOutput(buildOutput.replace(/\r?\n/g, '\r\n') + '\r\n');
            if (token.isCancellationRequested) {
                items.forEach(item => run.skipped(item));
                continue;
            }
            if (build.exitCode !== 0) {
                items.forEach(item => run.errored(item, new vscode.TestMessage(buildOutput.trim() || 'Failed to build test executable for debugging.')));
                continue;
            }

            const sessionName = `Debug Odin Tests (${path.basename(pkgDir)})`;
            const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(pkgDir));
            const stdoutPath = path.join(tempDir, 'stdout.log');
            const stderrPath = path.join(tempDir, 'stderr.log');
            let resolveTermination: (() => void) | undefined;
            const terminated = new Promise<void>(resolve => { resolveTermination = resolve; });
            const terminationSubscription = vscode.debug.onDidTerminateDebugSession(session => {
                if (session.name === sessionName) {
                    terminationSubscription.dispose();
                    resolveTermination?.();
                }
            });
            const cancelSubscription = token.onCancellationRequested(() => {
                const activeSession = vscode.debug.activeDebugSession;
                if (activeSession?.name === sessionName) {
                    void vscode.debug.stopDebugging(activeSession);
                }
            });
            // CodeLLDB otherwise sends the debuggee's stdio straight to its
            // terminal/debug console. File-backed streams let the Test Results
            // item show output while the debug session is running.
            const stopOutputCapture = debuggerType === 'lldb'
                ? tailDebugOutput([stdoutPath, stderrPath], run, items.length === 1 ? items[0] : undefined)
                : undefined;
            const started = await vscode.debug.startDebugging(folder, {
                type: debuggerType,
                request: 'launch',
                name: sessionName,
                program: executable,
                cwd: pkgDir,
                args: [],
                stopOnEntry: false,   // lldb / CodeLLDB
                stopAtEntry: false,   // cppvsdbg / cppdbg
                ...(debuggerType === 'lldb' ? {
                    terminal: 'integrated',
                    stdio: [null, stdoutPath, stderrPath],
                } : {}),
                ...(debuggerType === 'cppdbg' || debuggerType === 'cppvsdbg' ? {
                    // cpptools exposes inferior output in its Debug Console and,
                    // with externalConsole disabled, the integrated terminal.
                    externalConsole: false,
                    logging: { programOutput: true },
                } : {}),
            });
            if (!started) {
                terminationSubscription.dispose();
                cancelSubscription.dispose();
                await stopOutputCapture?.();
                items.forEach(item => run.errored(item, new vscode.TestMessage(
                    `Could not start debugger type '${debuggerType}'. Install a compatible debug adapter (cppvsdbg needs the C/C++ extension on Windows; lldb needs CodeLLDB) and set odinTestExplorer.debuggerType.`
                )));
            } else {
                await terminated;
                cancelSubscription.dispose();
                await stopOutputCapture?.();
                items.forEach(item => run.skipped(item));
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            items.forEach(item => run.errored(item, new vscode.TestMessage(message)));
        } finally {
            if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
    run.end();
}

function tailDebugOutput(
    files: string[],
    run: vscode.TestRun,
    test?: vscode.TestItem
): () => Promise<void> {
    let stopped = false;
    const offsets = files.map(() => 0);
    const readNewOutput = async () => {
        for (let i = 0; i < files.length; i++) {
            try {
                const contents = await fs.readFile(files[i]);
                if (contents.length <= offsets[i]) continue;
                const text = contents.subarray(offsets[i]).toString('utf8');
                offsets[i] = contents.length;
                if (text) run.appendOutput(text.replace(/\r?\n/g, '\r\n'), undefined, test);
            } catch {
                // A redirected stream file may not exist until its first write.
            }
        }
    };
    const polling = (async () => {
        while (!stopped) {
            await readNewOutput();
            if (!stopped) await new Promise(resolve => setTimeout(resolve, 100));
        }
        await readNewOutput();
    })();
    return async () => {
        stopped = true;
        await polling;
    };
}

interface ExecResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

function execOdin(
    bin: string,
    args: string[],
    cwd: string,
    token: vscode.CancellationToken
): Promise<ExecResult> {
    return new Promise(resolve => {
        const child = execFile(bin, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            const exitCode = err && typeof (err as NodeJS.ErrnoException).code === 'number'
                ? Number((err as NodeJS.ErrnoException).code)
                : err
                    ? 1
                    : 0;
            resolve({ exitCode, stdout, stderr });
        });

        const cancelSub = token.onCancellationRequested(() => {
            child.kill();
        });

        child.on('close', () => cancelSub.dispose());
    });
}

/**
 * Parses Odin test error lines such as:
 * [ERROR] --- [2026-11-19 19:50:00] [math_test.odin:14:test_add()] Expected 4, got 5
 */
function parseOdinTestErrors(output: string, pkgDir: string): Map<string, vscode.TestMessage[]> {
    const map = new Map<string, vscode.TestMessage[]>();
    const lines = output.split(/\r?\n/);

    // Strip ANSI escape codes if any remain
    const ansiRegex = /\x1b\[[0-9;]*m/g;
    const errorLineRegex = /^\[ERROR\s*\]\s*---\s*(?:\[[^\]]+\]\s*)?\[([^:\]]+):(\d+):([a-zA-Z0-9_]+)\(\)\]\s*(.*)$/;

    for (const rawLine of lines) {
        const line = rawLine.replace(ansiRegex, '').trim();
        const match = errorLineRegex.exec(line);
        if (!match) {
            continue;
        }

        const [, fileName, lineStr, procName, messageText] = match;
        const msg = new vscode.TestMessage(messageText || 'Test assertion failed');

        const lineNum = Math.max(0, parseInt(lineStr, 10) - 1);
        const filePath = path.isAbsolute(fileName) ? fileName : path.join(pkgDir, fileName);
        msg.location = new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(lineNum, 0));

        const existing = map.get(procName) ?? [];
        existing.push(msg);
        map.set(procName, existing);
    }

    return map;
}

export function deactivate() {}
