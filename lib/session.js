const EventEmitter = require("events");

function generateFunctionCode(f, args, type) {
    if (typeof f === "function") {
        const serializedArgs = JSON.stringify(args);
        if (type === "eval") {
            return `(${String(f)})(${serializedArgs})`;
        }
        if (type === "function") {
            const serializedCode = JSON.stringify(`return (${String(f)})(arguments[0])`);
            return `(new Function(${serializedCode}))(${serializedArgs})`;
        }
    }
    return String(f);
}

class QuickJSStackFrame {
    constructor(session, frameInfo) {
        this.session = session;
        this.id = frameInfo.id;
        this.name = frameInfo.name;
        this.fileName = frameInfo.filename;
        this.lineNumber = frameInfo.line;
    }

    async evaluateExpression(expression) {
        return this.session.evaluate(this.id, expression);
    }

    async evaluateHandle(f, args) {
        return this.evaluateExpression(generateFunctionCode(f, args, "eval"));
    }

    async evaluateHandleGlobal(f, args) {
        return this.evaluateExpression(generateFunctionCode(f, args, "function"));
    }

    async evaluate(f, args) {
        return (await this.evaluateHandle(f, args)).inspect();
    }

    async evaluateGlobal(f, args) {
        return (await this.evaluateHandleGlobal(f, args)).inspect();
    }

    async getScopes() {
        return this.session.getScopes(this.id);
    }
}

const QuickJSRef = Symbol("QuickJSRef");
class QuickJSHandle {
    constructor(session, reference) {
        this.session = session;
        this.ref = reference;
    }

    async getProperties(options) {
        return this.session.inspectVariable(this.ref, options);
    }

    async inspect(options) {
        const referenceMap = new Map();
        const { maxDepth, inspectProto } = options ?? {};
        return this.inspectInternal(maxDepth ?? 16, {
            referenceMap,
            inspectProto
        });
    }

    async inspectInternal(depth, options) {
        const { referenceMap, inspectProto } = options;
        if (this.primitive) {
            return this.value;
        }
        if (referenceMap.has(this.ref)) {
            return referenceMap.get(this.ref);
        }
        if (this.type === "object") {
            if (depth > 0) {
                let result;
                let getPropOptions;
                let properties;
                if (this.isArray) {
                    result = [];
                    getPropOptions = {
                        filter: "indexed",
                        start: 0,
                        count: this.indexedCount
                    };
                } else {
                    result = {};
                }
                referenceMap.set(this.ref, result);
                try {
                    properties = await this.getProperties(getPropOptions);
                } catch (err) {
                    properties = [];
                }
                await Promise.all(properties.map(async (property) => {
                    if (property.name === "__proto__") {
                        if (inspectProto) {
                            const proto = await property.inspectInternal(depth - 1, options);
                            if (typeof proto === "object") {
                                Object.setPrototypeOf(result, proto);
                            }
                        }
                    } else {
                        result[property.name] = await property.inspectInternal(depth - 1, options);
                    }
                }));
                Object.defineProperty(result, QuickJSRef, {
                    enumerable: false,
                    configurable: false,
                    value: this.ref
                });
                return result;
            }
        }
        return String(this);
    }

    toString() {
        return this.valueAsString || String(this.value);
    }

    equals(x) {
        return this.ref === x.ref;
    }
}

class QuickJSScope extends QuickJSHandle {
    constructor(session, scopeInfo) {
        super(session, scopeInfo.reference);
        this.name = scopeInfo.name;
        this.type = "object";
        this.primitive = false;
        this.isArray = false;
        this.expensive = scopeInfo.expensive;
    }

    toString() {
        return `[scope ${this.name}]`;
    }
}

class QuickJSVariable extends QuickJSHandle {
    constructor(session, variableInfo) {
        super(session, variableInfo.variablesReference);
        this.name = variableInfo.name;
        this.type = variableInfo.type;
        this.primitive = true;
        this.isArray = false;
        switch (this.type) {
            case "string":
                this.value = variableInfo.value;
                break;
            case "integer":
                this.value = parseInt(variableInfo.value, 10);
                break;
            case "float":
                this.value = parseFloat(variableInfo.value);
                break;
            case "boolean":
                this.value = variableInfo.value === "true";
                break;
            case "null":
                this.value = null;
                break;
            case "undefined":
                this.value = undefined;
                break;
            case "object":
            case "function":
                this.primitive = false;
                this.isArray = variableInfo.indexedVariables !== undefined;
                this.indexedCount = variableInfo.indexedVariables;
                // falls through
            default:
                this.valueAsString = variableInfo.value;
                this.primitive = false;
                break;
        }
    }
}

class QuickJSDebugSession extends EventEmitter {
    constructor(protocol) {
        super();
        this.protocol = protocol;
        protocol.on("StoppedEvent", (ev) => {
            this.emit("stopped", ev);
        });
        protocol.on("ThreadEvent", (ev) => {
            this.emit("context", ev);
        });
        protocol.on("PrintEvent", (ev) => {
            this.emit("log", ev);
        });
        protocol.on("ProtocolEvent", (ev) => {
            this.emit("protocol", ev);
        });
        protocol.on("terminated", (ev) => {
            this.emit("end", ev);
        });
    }

    async continue() {
        return this.protocol.sendRequest("continue");
    }

    async pause() {
        return this.protocol.sendRequest("pause");
    }

    async stepNext() {
        return this.protocol.sendRequest("next");
    }

    async stepIn() {
        return this.protocol.sendRequest("stepIn");
    }

    async stepOut() {
        return this.protocol.sendRequest("stepOut");
    }

    async evaluate(frameId, expression) {
        const res = await this.protocol.sendRequest("evaluate", { frameId, expression });
        return new QuickJSVariable(this, { ...res, name: "result", value: res.result });
    }

    async traceStack() {
        const res = await this.protocol.sendRequest("stackTrace");
        return res.map((e) => new QuickJSStackFrame(this, e));
    }

    async getTopStack() {
        return (await this.traceStack())[0];
    }

    async getScopes(frameId) {
        const res = await this.protocol.sendRequest("scopes", { frameId });
        return res.map((e) => new QuickJSScope(this, e));
    }

    async inspectVariable(reference, options) {
        const res = await this.protocol.sendRequest("variables", {
            variablesReference: reference,
            ...options
        });
        return res.map((e) => new QuickJSVariable(this, e));
    }

    resume() {
        this.protocol.sendMessage({
            type: "resume",
            version: 1
        });
    }

    setBreakpoints(fileName, lineNumbers) {
        this.protocol.sendMessage({
            type: "breakpoints",
            breakpoints: {
                path: fileName,
                breakpoints: lineNumbers ? lineNumbers.map((line) => ({ line })) : undefined
            },
            version: 1
        });
    }

    setStopOnException(enabled) {
        this.protocol.sendMessage({
            type: "stopOnException",
            stopOnException: enabled,
            version: 1
        });
    }
}

module.exports = { QuickJSDebugSession };
