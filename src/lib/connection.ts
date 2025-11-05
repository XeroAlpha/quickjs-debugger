import { Buffer } from 'node:buffer';
import EventEmitter from 'node:events';
import type { Socket } from 'node:net';

function addMessageListener(socket: Socket, onMessage: (buffer: Buffer<ArrayBuffer>) => void) {
    const chunks: Buffer<ArrayBuffer>[] = [];
    let bufferLength = 0;
    let state: 'content' | 'length' = 'length';
    let triggerLength = 9;
    socket.on('data', (chunk) => {
        bufferLength += chunk.length;
        chunks.push(chunk);
        while (bufferLength >= triggerLength) {
            const bufferedChunk = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
            const triggerChunk = bufferedChunk.subarray(0, triggerLength);
            bufferLength -= triggerLength;
            chunks.splice(0, chunks.length, bufferedChunk.subarray(triggerLength));
            switch (state) {
                case 'length':
                    state = 'content';
                    triggerLength = parseInt(triggerChunk.toString(), 16);
                    break;
                case 'content':
                    onMessage(triggerChunk);
                    state = 'length';
                    triggerLength = 9;
                    break;
            }
        }
    });
}

export interface DebugConnection extends EventEmitter {
    close(): void;
    sendEnvelope(type: string, data?: object): void;
    sendRequest<R = void, T extends object = object>(command: string, args?: T): Promise<R>;
}

export interface DebugEnvelope {
    version: number;
    type: string;
    [key: string]: unknown;
}

export interface DebuggerRequest {
    request_seq: number;
    command: string;
    args: unknown;
}

export interface DebuggeeEvent {
    type: string;
    [key: string]: unknown;
}

export interface DebuggeeResponse extends DebugEnvelope {
    type: 'response';
    request_seq: number;
    error?: string;
    body?: unknown;
}

export class QuickJSDebugConnection extends EventEmitter implements DebugConnection {
    socket: Socket;
    requestTimeout: number;
    requestVersion: number;
    requestSeq: number;
    requestReactions: Map<number, { resolve: (value: unknown) => void; reject: (error?: unknown) => void }>;
    constructor(socket: Socket) {
        super();
        this.socket = socket;
        this.requestTimeout = 10000;
        this.requestVersion = 1;
        this.requestSeq = 1;
        this.requestReactions = new Map();
        addMessageListener(socket, (message) => {
            this.handleMessage(message);
        });
        socket.on('end', () => {
            this.emit('end');
            const reactions = [...this.requestReactions.values()];
            this.requestReactions.clear();
            reactions.forEach(({ reject }) => {
                reject(new Error('Protocol is closed'));
            });
            this.requestReactions.clear();
        });
        socket.on('error', (err) => this.emit('error', err));
    }

    close() {
        this.socket.end();
    }

    sendMessage<T>(message: T) {
        const buffer = Buffer.from(`${JSON.stringify(message)}\n`);
        const lf = Buffer.from('\n');
        const packet = Buffer.concat([Buffer.from(buffer.length.toString(16).padStart(8, '0')), lf, buffer]);
        this.socket.write(packet);
    }

    sendEnvelope(type: string, data?: object) {
        this.sendMessage({
            version: this.requestVersion,
            type,
            ...data,
        } as DebugEnvelope);
    }

    sendRequestRaw(command: string, args?: object) {
        const { requestSeq } = this;
        this.requestSeq += 1;
        this.sendEnvelope('request', {
            request: {
                request_seq: requestSeq,
                command,
                args,
            } as DebuggerRequest,
        });
        return requestSeq;
    }

    sendRequest<R = void, T extends object = object>(command: string, args?: T) {
        const requestSeq = this.sendRequestRaw(command, args);
        const timeoutError = new Error(`Request timeout ${this.requestTimeout}ms exceed.`);
        const { promise, resolve, reject } = Promise.withResolvers<R>();
        this.requestReactions.set(requestSeq, { resolve: resolve as (value: unknown) => void, reject });
        const timeout = setTimeout(() => {
            reject(timeoutError);
        }, this.requestTimeout);
        return promise.finally(() => {
            clearTimeout(timeout);
            this.requestReactions.delete(requestSeq);
        });
    }

    handleMessage(message: Buffer) {
        const json = JSON.parse(message.toString()) as DebugEnvelope;
        if (json.type === 'event') {
            const event = json.event as DebuggeeEvent;
            this.emit(event.type, event);
        } else if (json.type === 'response') {
            const response = json as DebuggeeResponse;
            const reaction = this.requestReactions.get(response.request_seq);
            if (reaction) {
                this.requestReactions.delete(response.request_seq);
                if (response.error) {
                    reaction.reject(new Error(response.error));
                } else {
                    reaction.resolve(response.body);
                }
            }
        }
    }
}
