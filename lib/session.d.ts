import { DebugProtocol } from "./protocol";

declare class TypedEventEmitter<EventMap extends { [key in keyof EventMap]: (...args: any) => any }> {
    on<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
    once<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
    off<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
    addListener<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
    removeListener<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
    removeAllListeners<E extends keyof EventMap>(event: E): this;
    listeners<E extends keyof EventMap>(event: E): EventMap[E][];
    rawListeners<E extends keyof EventMap>(event: E): EventMap[E][];
    emit<E extends keyof EventMap>(event: E, ...args: Parameters<EventMap[E]>): boolean;
    prependListener<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
    prependOnceListener<E extends keyof EventMap>(event: E, listener: EventMap[E]): this;
    
    on(event: string | symbol, listener: (...args: any[]) => void): this;
    once(event: string | symbol, listener: (...args: any[]) => void): this;
    off(event: string | symbol, listener: (...args: any[]) => void): this;
    addListener(event: string | symbol, listener: (...args: any[]) => void): this;
    removeListener(event: string | symbol, listener: (...args: any[]) => void): this;
    removeAllListeners(event: string | symbol): this;
    listeners(event: string | symbol): ((...args: any[]) => void)[];
    rawListeners(event: string | symbol): ((...args: any[]) => void)[];
    emit(event: string | symbol, ...args: any[]): boolean;
    prependListener(event: string | symbol, listener: (...args: any[]) => void): this;
    prependOnceListener(event: string | symbol, listener: (...args: any[]) => void): this;

    listenerCount<E extends keyof EventMap>(event: E | string | symbol): number;
    eventNames(): (keyof EventMap)[];
}

interface PropertyListOptions {
    filter: "indexed";
    start: number;
    count: number;
}

declare namespace QuickJSDebugSessionEvent {
    enum StoppedReason {
        Entry = "entry",
        Exception = "exception",
        Breakpoint = "breakpoint",
        Pause = "pause",
        Step = "step",
        StepIn = "stepIn",
        StepOut = "stepOut"
    }

    interface Stopped {
        thread: number;
        reason: StoppedReason;
    }
    
    enum ContextReason {
        New = "new",
        Exited = "exited"
    }

    interface Context {
        thread: number;
        reason: ContextReason;
    }

    enum LogLevel {
        Info = 1,
        Warn = 2,
        Error = 3
    }

    interface Print {
        message: string;
        logLevel: LogLevel
    }

    interface Protocol {
        version: number;
        reason: string;
    }

    interface Map {
        stopped: (event: Stopped) => void;
        context: (event: Context) => void;
        log: (event: Print) => void;
        protocol: (event: Protocol) => void;
        end: () => void;
    }
}

declare class QuickJSDebugSession extends TypedEventEmitter<QuickJSDebugSessionEvent.Map> {
    constructor(protocol: DebugProtocol);
    continue(): Promise<void>;
    pause(): Promise<void>;
    stepNext(): Promise<void>;
    stepIn(): Promise<void>;
    stepOut(): Promise<void>;
    evaluate(frameId: number, expression: string): Promise<QuickJSVariable<any>>;
    traceStack(): Promise<QuickJSStackFrame[]>;
    getTopStack(): Promise<QuickJSStackFrame>;
    getScopes(frameId: number): Promise<QuickJSScope[]>;
    inspectVariable(reference: number, options?: PropertyListOptions): Promise<QuickJSVariable<any>[]>;
    resume(): void;
    setBreakpoints(fileName: string, lineNumbers?: number[]): void;
    setStopOnException(enabled: boolean): void;
}

declare class QuickJSStackFrame {
    id: number;
    name: string;
    fileName?: string;
    lineNumber?: number;

    evaluateExpression(expression: string): Promise<QuickJSVariable<any>>;
    getScopes(): Promise<QuickJSScope[]>;
    
    evaluate(expression: string): Promise<any>;
    evaluate<T, R>(f: (args: T) => R, args: T): Promise<R>;
    evaluateGlobal<T, R>(f: (args: T) => R, args: T): Promise<R>;
    evaluateHandle<T, R>(f: (args: T) => R, args: T): Promise<QuickJSVariable<R>>;
    evaluateHandleGlobal<T, R>(f: (args: T) => R, args: T): Promise<QuickJSVariable<R>>;
}

interface InspectOptions {
    maxDepth?: number;
    inspectProto?: boolean;
}

declare class QuickJSHandle<T> {
    ref: number;
    primitive: boolean;
    isArray: boolean;
    indexedCount?: number;
    getProperties(options?: PropertyListOptions): Promise<QuickJSVariable<any>[]>;
    inspect(maxDepth?: number): Promise<T>;
}

declare class QuickJSScope extends QuickJSHandle<object> {
    name: string;
    expensive: boolean;
}

declare class QuickJSVariable<T> extends QuickJSHandle<T> {
    name: string;
    type: string;
    value?: unknown;
}