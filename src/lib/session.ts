import EventEmitter from 'node:events';
import type { DebugProtocol } from '@vscode/debugprotocol';
import type { DebugConnection, DebuggeeEvent } from './connection.js';

function generateFunctionCode<T = unknown>(
    f: ((args: T) => unknown) | string,
    args: T | undefined,
    type: 'eval' | 'function',
) {
    if (typeof f === 'function') {
        const serializedArgs = JSON.stringify(args);
        if (type === 'eval') {
            return `(${String(f)})(${serializedArgs})`;
        } else {
            const serializedCode = JSON.stringify(`return (${String(f)})(arguments[0])`);
            return `(new Function(${serializedCode}))(${serializedArgs})`;
        }
    }
    return String(f);
}

export interface StackFrameInfo {
    id: number;
    name: string;
    filename: string;
    line: number;
    column: number;
}

export class QuickJSStackFrame {
    session: QuickJSDebugSession;
    id: number;
    name: string;
    fileName: string;
    lineNumber: number;
    constructor(session: QuickJSDebugSession, frameInfo: StackFrameInfo) {
        this.session = session;
        this.id = frameInfo.id;
        this.name = frameInfo.name;
        this.fileName = frameInfo.filename;
        this.lineNumber = frameInfo.line;
    }

    async evaluateExpression<R = unknown>(expression: string) {
        return this.session.evaluate<R>(this.id, expression);
    }

    async evaluateHandle<T, R>(f: (args: T) => R, args?: T): Promise<QuickJSVariable<R>> {
        return this.evaluateExpression<R>(generateFunctionCode(f, args, 'eval'));
    }

    async evaluateHandleGlobal<T, R>(f: (args: T) => R, args?: T): Promise<QuickJSVariable<R>> {
        return this.evaluateExpression<R>(generateFunctionCode(f, args, 'function'));
    }

    async evaluate<T, R>(f: (args: T) => R, args?: T): Promise<R> {
        return (await this.evaluateHandle(f, args)).inspect();
    }

    async evaluateGlobal<T, R>(f: (args: T) => R, args?: T): Promise<R> {
        return (await this.evaluateHandleGlobal(f, args)).inspect();
    }

    async getScopes() {
        return this.session.getScopes(this.id);
    }
}

export interface InspectOptions {
    maxDepth?: number;
    inspectProto?: boolean;
}

interface InspectInternalOptions {
    inspectProto?: boolean;
    referenceMap: Map<number, unknown>;
}

const QuickJSRef = Symbol('QuickJSRef');
interface WithQuickJSRef {
    [QuickJSRef]: number;
}

export class QuickJSHandle<T = unknown> {
    session: QuickJSDebugSession;
    name: string;
    ref: number;
    primitive?: boolean;
    primitiveValue?: unknown;
    type?: string;
    isArray?: boolean;
    indexedCount?: number;
    valueAsString?: string;
    constructor(session: QuickJSDebugSession, reference: number) {
        this.session = session;
        this.ref = reference;
        this.name = `#${reference}`;
    }

    async getProperties(options?: Omit<DebugProtocol.VariablesArguments, 'variablesReference'>) {
        return this.session.inspectVariable(this.ref, options);
    }

    async inspect(options?: InspectOptions) {
        const referenceMap = new Map<number, unknown>();
        const { maxDepth, inspectProto } = options ?? {};
        return this.inspectInternal(maxDepth ?? 16, {
            referenceMap,
            inspectProto,
        }) as Promise<T>;
    }

    private async inspectInternal(depth: number, options: InspectInternalOptions) {
        const { referenceMap, inspectProto } = options;
        if (this.primitive) {
            return this.primitiveValue;
        }
        if (referenceMap.has(this.ref)) {
            return referenceMap.get(this.ref);
        }
        if (this.type === 'object') {
            if (depth > 0) {
                let result: object;
                let getPropOptions: Omit<DebugProtocol.VariablesArguments, 'variablesReference'> | undefined;
                let properties: QuickJSVariable[];
                if (this.isArray) {
                    result = [];
                    getPropOptions = {
                        filter: 'indexed',
                        start: 0,
                        count: this.indexedCount,
                    };
                } else {
                    result = {};
                }
                referenceMap.set(this.ref, result);
                try {
                    properties = await this.getProperties(getPropOptions);
                } catch (_) {
                    properties = [];
                }
                await Promise.all(
                    properties.map(async (property) => {
                        if (property.name === '__proto__') {
                            if (inspectProto) {
                                const proto = await property.inspectInternal(depth - 1, options);
                                if (typeof proto === 'object') {
                                    Object.setPrototypeOf(result, proto);
                                }
                            }
                        } else {
                            (result as Record<string, unknown>)[property.name] = await property.inspectInternal(
                                depth - 1,
                                options,
                            );
                        }
                    }),
                );
                (result as WithQuickJSRef)[QuickJSRef] = this.ref;
                return result;
            }
        }
        return String(this);
    }

    toString() {
        return this.valueAsString ?? String(this.primitiveValue);
    }

    valueOf() {
        return this.primitiveValue ?? this.valueAsString;
    }

    equals(x: QuickJSHandle | null | undefined) {
        if (!x) return false;
        return this.ref === x.ref;
    }
}

export interface ScopeInfo {
    name: string;
    reference: number;
    expensive: boolean;
}

export class QuickJSScope extends QuickJSHandle<Record<string, unknown>> {
    expensive: boolean;
    constructor(session: QuickJSDebugSession, scopeInfo: ScopeInfo) {
        super(session, scopeInfo.reference);
        this.name = scopeInfo.name;
        this.type = 'object';
        this.primitive = false;
        this.isArray = false;
        this.expensive = scopeInfo.expensive;
    }

    toString() {
        return `[scope ${this.name}]`;
    }
}

export interface VariableInfo {
    name: string;
    value: string;
    type?: string;
    variablesReference: number;
    indexedVariables?: number;
}

export class QuickJSVariable<T = unknown> extends QuickJSHandle<T> {
    constructor(session: QuickJSDebugSession, variableInfo: VariableInfo) {
        super(session, variableInfo.variablesReference);
        this.name = variableInfo.name;
        this.type = variableInfo.type;
        this.primitive = true;
        this.isArray = false;
        switch (this.type) {
            case 'string':
                this.primitiveValue = variableInfo.value;
                break;
            case 'integer':
                this.primitiveValue = parseInt(variableInfo.value, 10);
                break;
            case 'float':
                this.primitiveValue = parseFloat(variableInfo.value);
                break;
            case 'boolean':
                this.primitiveValue = variableInfo.value === 'true';
                break;
            case 'null':
                this.primitiveValue = null;
                break;
            case 'undefined':
                this.primitiveValue = undefined;
                break;
            case 'object':
            case 'function':
                this.primitive = false;
                this.valueAsString = variableInfo.value;
                this.isArray = variableInfo.indexedVariables !== undefined;
                this.indexedCount = variableInfo.indexedVariables;
                break;
            default:
                this.primitive = false;
                this.valueAsString = variableInfo.value;
                break;
        }
    }
}

export interface BreakpointInfo {
    line: number;
    column?: number;
}

export interface BreakpointStatus {
    verified: boolean;
}

export interface StoppedEvent extends DebuggeeEvent {
    type: 'StoppedEvent';
    thread: number;
    reason: 'entry' | 'exception' | 'breakpoint' | 'pause' | 'step' | 'stepIn' | 'stepOut';
}

export interface ContextEvent {
    type: 'ThreadEvent';
    thread: number;
    reason: 'new' | 'exited';
}

export type EvaluateContext = 'watch' | 'repl' | 'hover' | 'clipboard' | 'variables';

export interface QuickJSDebugSessionEvents {
    stopped: [event: StoppedEvent];
    context: [event: ContextEvent];
    end: [];
}

export class QuickJSDebugSession extends EventEmitter<QuickJSDebugSessionEvents> {
    connection: DebugConnection;
    constructor(connection: DebugConnection) {
        super();
        this.connection = connection;
        connection.on('event:StoppedEvent', (ev) => {
            this.emit('stopped', ev as StoppedEvent);
        });
        connection.on('event:ThreadEvent', (ev) => {
            this.emit('context', ev as ContextEvent);
        });
        connection.on('event:terminated', () => {
            this.emit('end');
        });
    }

    async continue() {
        return this.connection.sendRequest<DebugProtocol.ContinueResponse['body']>('continue');
    }

    async pause() {
        return this.connection.sendRequest('pause');
    }

    async stepNext() {
        return this.connection.sendRequest('next');
    }

    async stepIn() {
        return this.connection.sendRequest('stepIn');
    }

    async stepOut() {
        return this.connection.sendRequest('stepOut');
    }

    async evaluate<R = unknown>(frameId: number, expression: string, context?: EvaluateContext) {
        const res = await this.connection.sendRequest<DebugProtocol.EvaluateResponse['body']>('evaluate', {
            frameId,
            context: context ?? 'watch',
            expression,
        } as DebugProtocol.EvaluateArguments);
        return new QuickJSVariable<R>(this, { ...res, name: 'result', value: res.result });
    }

    async traceStack() {
        const res = await this.connection.sendRequest<StackFrameInfo[]>('stackTrace');
        return res.map((e) => new QuickJSStackFrame(this, e));
    }

    async getTopStack() {
        return (await this.traceStack())[0];
    }

    async getScopes(frameId: number) {
        const res = await this.connection.sendRequest<ScopeInfo[]>('scopes', {
            frameId,
        } as DebugProtocol.ScopesArguments);
        return res.map((e) => new QuickJSScope(this, e));
    }

    async inspectVariable<T = unknown>(
        reference: number,
        options?: Omit<DebugProtocol.VariablesArguments, 'variablesReference'>,
    ) {
        const res = await this.connection.sendRequest<VariableInfo[]>('variables', {
            variablesReference: reference,
            ...options,
        } as DebugProtocol.VariablesArguments);
        return res.map((e) => new QuickJSVariable<T>(this, e));
    }

    resume() {
        this.connection.sendEnvelope('resume');
    }

    setBreakpoints(fileName: string, breakpoints: BreakpointInfo[]) {
        this.connection.sendEnvelope('breakpoints', {
            breakpoints: {
                path: fileName,
                breakpoints: breakpoints.length ? breakpoints : undefined,
            },
        });
    }

    async setBreakpointLines(fileName: string, breakpointsLines: number[]) {
        const status = await this.connection.sendRequest<{
            breakpoints: BreakpointStatus[];
        }>('setBreakpoints', {
            path: fileName,
            breakpoints: breakpointsLines,
        });
        return status.breakpoints;
    }

    setStopOnException(enabled: boolean) {
        this.connection.sendEnvelope('stopOnException', {
            stopOnException: enabled,
        });
    }
}
