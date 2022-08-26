const assert = require("assert").strict;
const net = require("net");
const { QuickJSDebugProtocol, QuickJSDebugSession } = require("../lib");

function main([port]) {
    const server = net.createServer(async (socket) => {
        const protocol = new QuickJSDebugProtocol(socket);
        const session = new QuickJSDebugSession(protocol);
        const topStack = await session.getTopStack();
        const expected = {
            number: 1,
            float: 0.125,
            string: "Hello world",
            boolean: false,
            null: null,
            undefined,
            object: { array: [1, 2, 3] }
        };
        const resultRef = await topStack.evaluateExpression(`({
            number: 1,
            float: 0.125,
            string: "Hello world",
            boolean: false,
            null: null,
            undefined,
            object: { array: [1, 2, 3] }
        })`.replace(/\n/g, ""));
        const result = await resultRef.inspect();
        assert.deepEqual(result, expected);
        process.stdout.write(await topStack.evaluate(() => "ok\n"));
        session.resume();
        protocol.close();
        server.close();
    });
    server.listen(port);
    process.stdout.write(`Please connect to <host>:${server.address().port}\n`);
}

main(process.argv.slice(2));
