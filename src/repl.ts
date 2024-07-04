#!/usr/bin/env node

import EventEmitter from 'events';
import net from 'net';
import readline from 'readline';
import repl from 'repl';
import util from 'util';
import {
    MinecraftDebugSession,
    QuickJSDebugConnection,
    QuickJSHandle,
    QuickJSScope,
    QuickJSStackFrame
} from './index.js';
import { Context } from 'vm';

class MCQuickJSDebugServer extends EventEmitter {
    server: net.Server;
    connection: QuickJSDebugConnection | null = null;
    breakpointMap = new Map<string, { line: number; column?: number }[]>();
    logLevel = 0;
    socket: net.Socket | null = null;
    session: MinecraftDebugSession | null = null;
    paused = false;
    stacks: QuickJSStackFrame[] = [];
    stackIndex = 0;
    currentStack: QuickJSStackFrame | null = null;
    constructor(port: number) {
        super();
        this.server = net.createServer((socket) => {
            this.onConnection(socket);
        });
        this.server.listen(port);
    }

    reset() {
        if (this.connection) {
            this.connection.close();
        }
        this.socket = null;
        this.connection = null;
        this.session = null;
        this.paused = false;
        this.stacks = [];
        this.stackIndex = 0;
        this.currentStack = null;
    }

    onConnection(socket: net.Socket) {
        if (this.connection != null) {
            socket.end();
            return;
        }
        const addressInfo = socket.address() as net.AddressInfo;
        const address = `${addressInfo.address}:${addressInfo.port}`;
        this.socket = socket;
        this.connection = new QuickJSDebugConnection(socket);
        this.session = new MinecraftDebugSession(this.connection);
        this.paused = true;
        this.emit('online', address);
        this.syncBreakpoints();
        this.session.on('stopped', (ev) => {
            this.paused = true;
            this.emit('stopped', ev);
            if (ev.reason === 'breakpoint') {
                this.emit('breakpointHit');
            }
            this.updateStateAsync();
        });
        this.session.on('log', (ev) => {
            if ((ev.logLevel as number) < this.logLevel) return;
            this.emit('log', ev);
        });
        this.session.on('end', () => {
            this.connection?.close();
        });
        this.connection.on('end', () => {
            this.connection = null;
            this.emit('offline', address);
            this.reset();
            this.emit('update');
        });
        this.updateStateAsync();
    }

    get port() {
        return (this.server.address() as net.AddressInfo).port;
    }

    wrapAsync<P extends unknown[]>(asyncFunc: (...args: P) => Promise<void>) {
        return (...args: P) => {
            asyncFunc(...args).catch((err) => this.emit('error', err));
        };
    }

    updateStateAsync() {
        this.updateState().catch((err) => this.emit('error', err));
    }

    async updateState() {
        if (this.session) {
            this.stacks = await this.session.traceStack();
            const stackIndex = this.stackIndex >= 0 ? this.stackIndex : this.stacks.length + this.stackIndex;
            this.currentStack = this.stacks[Math.max(Math.min(stackIndex, this.stacks.length - 1), 0)];
            this.emit('update');
            return;
        }
        throw new Error('Debuggee is offline');
    }

    async evaluate(expression: string) {
        if (this.currentStack) {
            const ref = await this.currentStack.evaluateExpression(expression);
            await this.updateState();
            return ref;
        }
        throw new Error('Debuggee is offline');
    }

    async dumpScope() {
        if (this.currentStack) {
            return this.currentStack.getScopes();
        }
        throw new Error('Debuggee is offline');
    }

    async dumpReference(ref: number, range?: readonly [number, number]) {
        if (this.session) {
            if (range) {
                return await this.session.inspectVariable(ref, {
                    filter: 'indexed',
                    start: range[0],
                    count: range[1] - range[0] + 1
                });
            }
            return await this.session.inspectVariable(ref);
        }
        throw new Error('Debuggee is offline');
    }

    syncBreakpoints() {
        if (this.session) {
            const session = this.session;
            this.breakpointMap.forEach((breakpoints, fileName) => {
                session.setBreakpoints(fileName, breakpoints);
            });
        }
    }

    addBreakpoint(lineNumber: number, fileName?: string) {
        const fn = fileName ?? this.currentStack?.fileName ?? '';
        if (!fn) {
            throw new Error('Invalid file name or not specified');
        }
        const breakpoints = this.breakpointMap.get(fn);
        if (breakpoints) {
            breakpoints.push({ line: lineNumber });
            breakpoints.sort();
        } else {
            this.breakpointMap.set(fn, [{ line: lineNumber }]);
        }
        this.syncBreakpoints();
        return true;
    }

    removeBreakpoint(lineNumber: number, fileName?: string) {
        const fn = fileName ?? this.currentStack?.fileName ?? '';
        if (!fn) {
            throw new Error('Invalid file name or not specified');
        }
        const breakpoints = this.breakpointMap.get(fn);
        if (breakpoints) {
            const index = breakpoints.findIndex((e) => e.line === lineNumber);
            if (index >= 0) {
                breakpoints.splice(index, 1);
                this.syncBreakpoints();
                return true;
            }
        }
        return false;
    }

    async executeCommand(command: string) {
        if (this.connection && this.session) {
            this.paused = false;
            this.emit('update');
            switch (command.toLowerCase()) {
                case 'resume':
                    this.session.resume();
                    break;
                case 'pause':
                    await this.session.pause();
                    break;
                case 'continue':
                    await this.session.continue();
                    break;
                case 'stepin':
                case 'step in':
                    await this.session.stepIn();
                    break;
                case 'stepout':
                case 'step out':
                    await this.session.stepOut();
                    break;
                case 'step':
                case 'next':
                case 'stepnext':
                case 'step next':
                    await this.session.stepNext();
                    break;
                default:
                    throw new Error(`Unknown command: ${command}`);
            }
            return;
        }
        throw new Error('Debuggee is offline');
    }

    async import(useRequire: boolean, module: string, alias?: string) {
        if (this.session) {
            const moduleCode = JSON.stringify(module);
            const aliasCode = JSON.stringify(alias ?? module);
            const stacks = await this.session.traceStack();
            const rootStack = stacks[stacks.length - 1];
            if (useRequire) {
                await rootStack.evaluateExpression(`((m)=>globalThis[${aliasCode}]=m)(require(${moduleCode}))`);
            } else {
                await rootStack.evaluateExpression(`import(${moduleCode}).then((m)=>globalThis[${aliasCode}]=m)`);
            }
            return;
        }
        throw new Error('Debuggee is offline');
    }
}

function inspectHandle(handle: QuickJSHandle) {
    let refStr = 'ref';
    if (handle.isArray && handle.indexedCount !== undefined) {
        refStr = `indexed 0..${handle.indexedCount - 1}`;
    }
    return `${handle.type} ${handle.name} <${refStr} *${handle.ref}> ${String(handle).replace(/\n/g, ' ')}`;
}

const LOG_LEVEL = ['debug', 'info', 'warn', 'error', 'silent'];

const integerRegex = /^\d+$/;
const breakpointRegex = /^(?:(.+)\s+)?([+-])?(\d+)$/;
const referenceLocatorRegex = /^(\d+)(?:\s+(\d+)\.\.(\d+))?$/;
const importRegex = /^(.+?)(?:\s+as\s+(\w+))?$/;
const inspectMethods = [
    ['js', '[Default] Inspect recursively but cost more time'],
    ['handle', 'Only show references of properties']
];
class DebuggerReplServer {
    repl: repl.REPLServer;
    server: MCQuickJSDebugServer;
    acceptUserInput: boolean;
    recentCommand: string;
    inspectMethod: string;
    constructor(port: number) {
        this.repl = repl.start({
            eval: (cmd, context, file, callback) => {
                this.doEval(cmd, context, file, callback);
            }
        });
        this.server = new MCQuickJSDebugServer(port);
        this.acceptUserInput = true;
        this.recentCommand = '';
        this.inspectMethod = 'js';
        this.defineDefaultCommands();
        this.repl.on('exit', () => {
            this.server.reset();
        });
        this.server
            .on('online', (address) => {
                this.printLine(`Connection established: ${address}.\nType ".help" for more information.`, true);
                this.updatePrompt();
                if (this.acceptUserInput) {
                    this.repl.displayPrompt(true);
                }
            })
            .on('offline', (address) => {
                this.printLine(`Connection disconnected: ${address}.`, true);
                this.showOfflinePrompt();
                this.updatePrompt();
                if (this.acceptUserInput) {
                    this.repl.displayPrompt(true);
                }
            })
            .on('update', () => {
                this.updatePrompt();
                if (this.acceptUserInput) {
                    this.repl.displayPrompt(true);
                }
            })
            .on('log', ({ message, logLevel }) => {
                if (this.repl.editorMode) return;
                const levelStr = LOG_LEVEL[logLevel as number];
                this.printLine(`[${levelStr}] ${message}`, true);
            })
            .on('error', (err) => {
                if (this.repl.editorMode) return;
                this.printLine(util.format('[Debugger] %s', err), true);
            });
        this.updatePrompt();
        this.showOfflinePrompt();
    }

    printLine(str: string, rewriteLine?: boolean) {
        if (rewriteLine) {
            readline.cursorTo(this.repl.output, 0);
            readline.clearLine(this.repl.output, 0);
        }
        this.repl.output.write(`${str}\n`);
        if (this.acceptUserInput) {
            this.repl.displayPrompt(true);
        }
    }

    showOfflinePrompt() {
        this.printLine(`Waiting for Debuggee to connect..... port:${this.server.port}`, true);
    }

    updatePrompt() {
        let prompt = '> ';
        if (this.server.session) {
            if (this.server.paused) {
                const stack = this.server.currentStack;
                if (this.recentCommand) {
                    prompt = `${this.recentCommand} ${prompt}`;
                }
                if (stack) {
                    const fileName = stack.fileName.slice(-16);
                    prompt = `[${fileName}:${stack.lineNumber}] ${prompt}`;
                }
            } else {
                prompt = `[Running] Pause ${prompt}`;
            }
        } else {
            prompt = `[Offline] ${prompt}`;
        }
        this.repl.setPrompt(prompt);
    }

    printStack() {
        if (this.server.currentStack) {
            const lines = this.server.stacks.map((stack, index, arr) => {
                const currectFlag = stack === this.server.currentStack;
                return `${currectFlag ? '*' : ' '} ${arr.length - index} ${stack.fileName}:${stack.lineNumber}`;
            });
            this.printLine(lines.join('\n'), true);
        }
    }

    printBreakpoints() {
        const lines = [];
        this.server.breakpointMap.forEach((breakpoints, fileName) => {
            breakpoints.forEach(({ line }) => {
                lines.push(`${fileName}:${line}`);
            });
        });
        if (!lines.length) {
            lines.push('Empty');
        }
        this.printLine(lines.join('\n'), true);
    }

    parseBreakpoint(str: string) {
        const match = breakpointRegex.exec(str);
        if (match) {
            const { currentStack } = this.server;
            if (currentStack) {
                let fileName = match[1];
                const offset = match[2];
                let lineNumber = Number(match[3]);
                if (offset === '+') {
                    lineNumber += currentStack.lineNumber;
                } else if (offset === '-') {
                    lineNumber -= currentStack.lineNumber;
                }
                if (!fileName) {
                    fileName = currentStack.fileName;
                }
                return { fileName, lineNumber };
            }
        }
        return null;
    }

    async inspect(handle: QuickJSHandle) {
        if (this.inspectMethod === 'handle') {
            return inspectHandle(handle);
        }
        return util.inspect(await handle.inspect(), { colors: true });
    }

    defineDefaultCommands() {
        this.repl.defineCommand('disconnect', {
            help: 'Disconnect from Debuggee',
            action: () => {
                this.server.reset();
                this.repl.displayPrompt(true);
            }
        });
        this.repl.defineCommand('stack', {
            help: 'Print stacks or switch current stack frame',
            action: this.server.wrapAsync(async (args) => {
                if (integerRegex.test(args)) {
                    this.server.stackIndex = -Number.parseInt(args, 10);
                    await this.server.updateState();
                }
                this.printStack();
            })
        });
        this.repl.defineCommand('breakpoints', {
            help: 'Show breakpoints',
            action: () => {
                this.printBreakpoints();
            }
        });
        this.repl.defineCommand('on', {
            help: 'Add breakpoint',
            action: (args) => {
                const parsed = this.parseBreakpoint(args);
                if (parsed) {
                    this.server.addBreakpoint(parsed.lineNumber, parsed.fileName);
                    this.printLine(`Breakpoint ${parsed.fileName}:${parsed.lineNumber} added`);
                } else {
                    this.printLine(`Invalid breakpoint: ${args}`);
                }
            }
        });
        this.repl.defineCommand('off', {
            help: 'Remove breakpoint',
            action: (args) => {
                const parsed = this.parseBreakpoint(args);
                if (parsed) {
                    this.server.removeBreakpoint(parsed.lineNumber, parsed.fileName);
                    this.printLine(`Breakpoint ${parsed.fileName}:${parsed.lineNumber} removed`);
                } else {
                    this.printLine(`Invalid breakpoint: ${args}`);
                }
            }
        });
        this.repl.defineCommand('scope', {
            help: 'Dump scope',
            action: this.server.wrapAsync(async (args) => {
                const scopes = await this.server.dumpScope();
                if (integerRegex.test(args)) {
                    const scope = scopes[Number.parseInt(args, 10)] as QuickJSScope | undefined;
                    if (scope) {
                        this.printLine(await this.inspect(scope));
                        return;
                    }
                    this.printLine(`Invalid scope: ${args}`);
                }
                this.printLine(scopes.map((scope, i) => `${i} ${inspectHandle(scope)}`).join('\n'));
            })
        });
        this.repl.defineCommand('ref', {
            help: 'Dump reference',
            action: this.server.wrapAsync(async (args) => {
                const match = referenceLocatorRegex.exec(args);
                if (match) {
                    const ref = Number.parseInt(match[1], 10);
                    const range = [Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)] as const;
                    const properties = await this.server.dumpReference(ref, Number.isNaN(range[0]) ? undefined : range);
                    const lines = properties.map(inspectHandle);
                    if (!lines.length) {
                        lines.push('None');
                    }
                    this.printLine(lines.join('\n'));
                } else {
                    this.printLine(`Invalid reference: ${args}`);
                }
            })
        });
        this.repl.defineCommand('setinspect', {
            help: 'Set inspect method',
            action: (args) => {
                const found = inspectMethods.find((e) => args === e[0]);
                if (found) {
                    [this.inspectMethod] = found;
                    this.printLine(`Inspect method has changed to ${this.inspectMethod}`);
                    return;
                }
                const lines = inspectMethods.map((e) => `${e[0]} - ${e[1]}`);
                if (args) {
                    lines.unshift(`Invalid inspect method: ${args}`);
                }
                this.printLine(lines.join('\n'));
            }
        });
        this.repl.defineCommand('loglevel', {
            help: 'Show or change log level',
            action: (args) => {
                const argsTrimmed = args.trim().toLowerCase();
                const index = LOG_LEVEL.indexOf(argsTrimmed);
                if (index >= 0) {
                    this.server.logLevel = index;
                    this.printLine(`Log level has changed to ${LOG_LEVEL[index]}`);
                } else {
                    this.printLine(
                        [
                            `Log level is ${LOG_LEVEL[this.server.logLevel]}`,
                            `Accept values: ${LOG_LEVEL.join(', ')}`
                        ].join('\n')
                    );
                }
            }
        });
        this.repl.defineCommand('require', {
            help: 'Require module to global scope',
            action: this.server.wrapAsync(async (args) => {
                const match = importRegex.exec(args);
                if (match) {
                    if (this.server.paused) {
                        await this.server.import(true, match[1], match[2]);
                        this.printLine(`Trying to require ${match[1]}`);
                    } else {
                        this.printLine('Dynamic require is not allowed when running');
                    }
                } else {
                    this.printLine(`Invalid import statement: ${args}`);
                }
            })
        });
        this.repl.defineCommand('import', {
            help: 'Import module to global scope',
            action: this.server.wrapAsync(async (args) => {
                const match = importRegex.exec(args);
                if (match) {
                    if (this.server.paused) {
                        await this.server.import(false, match[1], match[2]);
                        this.printLine(`Trying to import ${match[1]} (Continuation is required)`);
                    } else {
                        this.printLine('Dynamic import is not allowed when running');
                    }
                } else {
                    this.printLine(`Invalid import statement: ${args}`);
                }
            })
        });
        this.repl.defineCommand('resume', {
            help: 'Resume control',
            action: this.server.wrapAsync(async () => {
                await this.server.executeCommand('Resume');
                this.repl.displayPrompt(true);
            })
        });
        this.repl.defineCommand('pause', {
            help: 'Pause execution',
            action: this.server.wrapAsync(async () => {
                await this.server.executeCommand((this.recentCommand = 'Pause'));
                this.repl.displayPrompt(true);
            })
        });
        this.repl.defineCommand('continue', {
            help: 'Continue current line',
            action: this.server.wrapAsync(async () => {
                await this.server.executeCommand((this.recentCommand = 'Continue'));
                this.repl.displayPrompt(true);
            })
        });
        this.repl.defineCommand('until', {
            help: 'Continue execution until specified breakpoint hit',
            action: this.server.wrapAsync(async (args) => {
                const parsed = this.parseBreakpoint(args);
                if (parsed) {
                    this.server.addBreakpoint(parsed.lineNumber, parsed.fileName);
                    this.server.on('breakpointHit', () => {
                        this.server.removeBreakpoint(parsed.lineNumber, parsed.fileName);
                    });
                    await this.server.executeCommand((this.recentCommand = 'Continue'));
                    this.repl.displayPrompt(true);
                } else {
                    this.printLine(`Invalid breakpoint: ${args}`);
                }
            })
        });
        this.repl.defineCommand('step', {
            help: 'Step current line',
            action: this.server.wrapAsync(async (type) => {
                if (type === 'in') {
                    await this.server.executeCommand((this.recentCommand = 'StepIn'));
                } else if (type === 'out') {
                    await this.server.executeCommand((this.recentCommand = 'StepOut'));
                } else {
                    await this.server.executeCommand((this.recentCommand = 'Step'));
                }
                this.repl.displayPrompt(true);
            })
        });
    }

    doEval(cmd: string, context: Context, file: string, callback: (err: Error | null, result?: unknown) => void) {
        this.acceptUserInput = false;
        try {
            if (this.server.session) {
                const trimmedCmd = cmd.trim();
                let result = null;
                if (this.server.paused) {
                    if (trimmedCmd.length > 0) {
                        result = this.server.evaluate(cmd);
                        result = result.then(async (res) => {
                            this.printLine(await this.inspect(res), true);
                        });
                    } else if (this.recentCommand) {
                        result = this.server.executeCommand(this.recentCommand);
                    } else {
                        callback(null);
                        return;
                    }
                } else {
                    result = this.server.executeCommand('Pause');
                }
                result
                    .then(
                        () => {
                            callback(null);
                        },
                        (err) => {
                            callback(err as Error);
                        }
                    )
                    .finally(() => {
                        this.acceptUserInput = true;
                    });
            } else {
                this.showOfflinePrompt();
                callback(null);
            }
        } catch (err) {
            callback(err as Error);
            this.acceptUserInput = true;
        }
    }
}

function main(port: number) {
    const replServer = new DebuggerReplServer(port);
    replServer.repl.on('exit', () => {
        process.exit(0);
    });
}

main(Number(process.argv[2]) || 19144);
