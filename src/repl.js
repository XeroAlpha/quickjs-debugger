#!/usr/bin/env node

const EventEmitter = require("events");
const net = require("net");
const readline = require("readline");
const repl = require("repl");
const util = require("util");
const { QuickJSDebugProtocol, QuickJSDebugSession } = require("../lib");

class QuickJSDebugServer extends EventEmitter {
    constructor(port) {
        super();
        this.server = net.createServer((socket) => {
            this.onConnection(socket);
        });
        this.server.listen(port);
        this.breakpointMap = new Map();
        this.logLevel = 0;
        this.reset();
    }

    reset() {
        if (this.protocol) {
            this.protocol.close();
        }
        this.socket = null;
        this.protocol = null;
        this.session = null;
        this.paused = false;
        this.stacks = [];
        this.stackIndex = 0;
        this.currentStack = null;
    }

    onConnection(socket) {
        if (this.protocol != null) {
            socket.end();
            return;
        }
        const address = `${socket.address().address}:${socket.address().port}`;
        this.socket = socket;
        this.protocol = new QuickJSDebugProtocol(socket);
        this.session = new QuickJSDebugSession(this.protocol);
        this.paused = true;
        this.emit("online", address);
        this.updateState();
        this.syncBreakpoints();
        this.session.on("stopped", async (ev) => {
            this.paused = true;
            this.emit("stopped", ev);
            if (ev.reason === "breakpoint") {
                this.emit("breakpointHit");
            }
            this.updateState();
        });
        this.session.on("log", (ev) => {
            if (ev.logLevel < this.logLevel) return;
            this.emit("log", ev);
        });
        this.session.on("end", () => {
            this.emit("offline", address);
            this.reset();
            this.emit("update");
        });
    }

    get port() {
        return this.server.address().port;
    }

    async updateState() {
        try {
            this.stacks = await this.session.traceStack();
            const stackIndex = this.stackIndex >= 0 ? this.stackIndex : this.stacks.length + this.stackIndex;
            this.currentStack = this.stacks[Math.max(Math.min(stackIndex, this.stacks.length - 1), 0)];
            this.emit("update");
        } catch (err) {
            this.emit("error", err);
        }
    }

    async evaluate(expression) {
        if (this.currentStack) {
            const ref = await this.currentStack.evaluateExpression(expression);
            await this.updateState();
            return ref;
        }
        throw new Error("Debugee is offline");
    }

    async dumpScope() {
        if (this.currentStack) {
            return this.currentStack.getScopes();
        }
        throw new Error("Debugee is offline");
    }

    async dumpReference(ref, range) {
        if (this.session) {
            try {
                if (range) {
                    return await this.session.inspectVariable(ref, {
                        filter: "indexed",
                        start: range[0],
                        count: range[1] - range[0] + 1
                    });
                }
                return await this.session.inspectVariable(ref);
            } catch (err) {
                this.emit("error", err);
                return [];
            }
        }
        throw new Error("Debugee is offline");
    }

    syncBreakpoints() {
        if (this.session) {
            this.breakpointMap.forEach((breakpoints, fileName) => {
                this.session.setBreakpoints(fileName, breakpoints.length ? breakpoints : undefined);
            });
        }
    }

    addBreakpoint(lineNumber, fileName) {
        if (this.currentStack) {
            const fn = fileName || this.currentStack.fileName;
            const breakpoints = this.breakpointMap.get(fn);
            if (breakpoints) {
                breakpoints.push(lineNumber);
                breakpoints.sort();
            } else {
                this.breakpointMap.set(fn, [lineNumber]);
            }
            this.syncBreakpoints();
            return true;
        }
        return false;
    }

    removeBreakpoint(lineNumber, fileName) {
        if (this.currentStack) {
            const fn = fileName || this.currentStack.fileName;
            const breakpoints = this.breakpointMap.get(fn);
            if (breakpoints) {
                const index = breakpoints.indexOf(lineNumber);
                if (index >= 0) {
                    breakpoints.splice(index, 1);
                    this.syncBreakpoints();
                    return true;
                }
            }
        }
        return false;
    }

    async executeCommand(command) {
        try {
            if (this.session) {
                this.paused = false;
                this.emit("update");
                switch (command.toLowerCase()) {
                    case "resume":
                        this.session.resume();
                        this.protocol.close();
                        break;
                    case "pause":
                        await this.session.pause();
                        break;
                    case "continue":
                        await this.session.continue();
                        break;
                    case "stepin":
                    case "step in":
                        await this.session.stepIn();
                        break;
                    case "stepout":
                    case "step out":
                        await this.session.stepOut();
                        break;
                    case "step":
                    case "next":
                    case "stepnext":
                    case "step next":
                        await this.session.stepNext();
                        break;
                    default:
                        throw new Error(`Unknown command: ${command}`);
                }
            } else {
                throw new Error("Debugee is offline");
            }
        } catch (err) {
            this.emit("error", err);
        }
    }
}

function inspectHandle(handle) {
    let refStr = "ref";
    if (handle.isArray) {
        refStr = `indexed 0..${handle.indexedCount - 1}`;
    }
    return `${handle.type} ${handle.name} <${refStr} *${handle.ref}> ${String(handle).replace(/\n/g, " ")}`;
}

const LOG_LEVEL = ["info", "warn", "error", "silent"];

const integerRegex = /\d+/;
const breakpointRegex = /(?:(.+)\s+)?([+-])?(\d+)/;
const referenceLocatorRegex = /(\d+)(?:\s+(\d+)\.\.(\d+))?/;
const inspectMethods = [
    ["js", "[Default] Inspect recursively but cost more time"],
    ["handle", "Only show references of properties"]
];
class DebuggerReplServer extends repl.REPLServer {
    constructor(port) {
        super({
            eval: (cmd, context, file, callback) => {
                this.doEval(cmd, context, file, callback);
            }
        });
        this.server = new QuickJSDebugServer(port);
        this.acceptUserInput = true;
        this.recentCommand = "";
        this.inspectMethod = "js";
        this.defineDefaultCommands();
        this.on("exit", () => this.server.reset());
        this.server
            .on("online", (address) => {
                this.printLine(
                    `Connection established: ${address}.\nType ".help" for more information.`,
                    true
                );
                this.updatePrompt();
                if (this.acceptUserInput) {
                    this.displayPrompt(true);
                }
            })
            .on("offline", (address) => {
                this.printLine(`Connection disconnected: ${address}.`, true);
                this.showOfflinePrompt(true);
                this.updatePrompt();
                if (this.acceptUserInput) {
                    this.displayPrompt(true);
                }
            })
            .on("update", () => {
                this.updatePrompt();
                if (this.acceptUserInput) {
                    this.displayPrompt(true);
                }
            })
            .on("log", ({ message, logLevel }) => {
                if (this.editorMode) return;
                const levelStr = LOG_LEVEL[logLevel];
                this.printLine(`[${levelStr}] ${message}`, true);
            })
            .on("error", (err) => {
                if (this.editorMode) return;
                this.printLine(util.format("[Debugger] %s", err), true);
            });
        this.updatePrompt();
        this.showOfflinePrompt();
    }

    printLine(str, rewriteLine) {
        if (rewriteLine) {
            readline.cursorTo(this.output, 0);
            readline.clearLine(this.output, 0);
        }
        this.output.write(`${str}\n`);
        if (this.acceptUserInput) {
            this.displayPrompt(true);
        }
    }

    showOfflinePrompt() {
        this.printLine(`Waiting for debugee to connect..... port:${this.server.port}`, true);
    }

    updatePrompt() {
        let prompt = "> ";
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
        this.setPrompt(prompt);
    }

    printStack() {
        if (this.server.currentStack) {
            const lines = this.server.stacks.map((stack, index, arr) => {
                const currectFlag = stack === this.server.currentStack;
                return `${currectFlag ? "*" : " "} ${arr.length - index} ${stack.fileName}:${stack.lineNumber}`;
            });
            this.printLine(lines.join("\n"), true);
        }
    }

    printBreakpoints() {
        const lines = [];
        this.server.breakpointMap.forEach((breakpoints, fileName) => {
            breakpoints.forEach((lineNumber) => {
                lines.push(`${fileName}:${lineNumber}`);
            });
        });
        if (!lines.length) {
            lines.push("Empty");
        }
        this.printLine(lines.join("\n"), true);
    }

    parseBreakpoint(str) {
        const match = breakpointRegex.exec(str);
        if (match) {
            const { currentStack } = this.server;
            if (currentStack) {
                let fileName = match[1];
                const offset = match[2];
                let lineNumber = match[3];
                if (offset === "+") {
                    lineNumber += currentStack.lineNumber;
                } else if (offset === "-") {
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

    async inspect(handle) {
        if (this.inspectMethod === "handle") {
            return inspectHandle(handle);
        }
        return util.inspect(await handle.inspect(), { colors: true });
    }

    defineDefaultCommands() {
        this.defineCommand("disconnect", {
            help: "Disconnect from debugee",
            action: () => {
                this.server.reset();
                this.displayPrompt(true);
            }
        });
        this.defineCommand("stack", {
            help: "Print stacks or switch current stack frame",
            action: async (args) => {
                if (integerRegex.test(args)) {
                    this.server.stackIndex = -Number.parseInt(args, 10);
                    await this.server.updateState();
                }
                this.printStack();
            }
        });
        this.defineCommand("breakpoints", {
            help: "Show breakpoints",
            action: () => {
                this.printBreakpoints();
            }
        });
        this.defineCommand("on", {
            help: "Add breakpoint",
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
        this.defineCommand("off", {
            help: "Remove breakpoint",
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
        this.defineCommand("scope", {
            help: "Dump scope",
            action: async (args) => {
                const scopes = await this.server.dumpScope();
                if (integerRegex.test(args)) {
                    const scope = scopes[Number.parseInt(args, 10)];
                    if (scope) {
                        this.printLine(await this.inspect(scope));
                        return;
                    }
                    this.printLine(`Invalid scope: ${args}`);
                }
                this.printLine(scopes.map((scope, i) => `${i} ${inspectHandle(scope)}`).join("\n"));
            }
        });
        this.defineCommand("ref", {
            help: "Dump reference",
            action: async (args) => {
                const match = referenceLocatorRegex.exec(args);
                if (match) {
                    const ref = Number.parseInt(match[1], 10);
                    const range = [Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)];
                    const properties = await this.server.dumpReference(ref, Number.isNaN(range[0]) ? undefined : range);
                    const lines = properties.map(inspectHandle);
                    if (!lines.length) {
                        lines.push("None");
                    }
                    this.printLine(lines.join("\n"));
                } else {
                    this.printLine(`Invalid reference: ${args}`);
                }
            }
        });
        this.defineCommand("setinspect", {
            help: "Set inspect method",
            action: async (args) => {
                const found = inspectMethods.find((e) => args === e[0]);
                if (found) {
                    [this.inspectMethod] = found;
                    this.printLine(`Inspect method has changed to ${this.inspectMethod}`);
                    return;
                }
                if (args) {
                    this.printLine(`Invalid inspect method: ${args}`);
                }
                this.printLine(inspectMethods.map((e) => `${e[0]} - ${e[1]}`).join("\n"));
            }
        });
        this.defineCommand("resume", {
            help: "Resume control",
            action: async () => {
                await this.server.executeCommand("Resume");
                this.displayPrompt(true);
            }
        });
        this.defineCommand("pause", {
            help: "Pause execution",
            action: async () => {
                await this.server.executeCommand(this.recentCommand = "Pause");
                this.displayPrompt(true);
            }
        });
        this.defineCommand("continue", {
            help: "Continue current line",
            action: async () => {
                await this.server.executeCommand(this.recentCommand = "Continue");
                this.displayPrompt(true);
            }
        });
        this.defineCommand("until", {
            help: "Continue execution until specified breakpoint hit",
            action: async (args) => {
                const parsed = this.parseBreakpoint(args);
                if (parsed) {
                    this.server.addBreakpoint(parsed.lineNumber, parsed.fileName);
                    this.server.on("breakpointHit", () => {
                        this.server.removeBreakpoint(parsed.lineNumber, parsed.fileName);
                    });
                    await this.server.executeCommand(this.recentCommand = "Continue");
                    this.displayPrompt(true);
                } else {
                    this.printLine(`Invalid breakpoint: ${args}`);
                }
            }
        });
        this.defineCommand("step", {
            help: "Step current line",
            action: async (type) => {
                if (type === "in") {
                    await this.server.executeCommand(this.recentCommand = "StepIn");
                } else if (type === "out") {
                    await this.server.executeCommand(this.recentCommand = "StepOut");
                } else {
                    await this.server.executeCommand(this.recentCommand = "Step");
                }
                this.displayPrompt(true);
            }
        });
    }

    doEval(cmd, context, file, callback) {
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
                    result = this.server.executeCommand("Pause");
                }
                result.then(() => {
                    callback(null);
                }, (err) => {
                    callback(err);
                }).finally(() => {
                    this.acceptUserInput = true;
                });
            } else {
                this.showOfflinePrompt();
                callback(null);
            }
        } catch (err) {
            callback(err);
            this.acceptUserInput = true;
        }
    }
}

function main(port) {
    const replServer = new DebuggerReplServer(port);
    replServer.on("exit", () => {
        process.exit(0);
    });
}

if (require.main === module) {
    main(Number(process.argv[2]) || 19144);
} else {
    module.exports = { QuickJSDebugServer, DebuggerReplServer, main };
}
