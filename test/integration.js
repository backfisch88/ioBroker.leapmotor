const path = require('path');
const { expect } = require('chai');
const { tests } = require('@iobroker/testing');

// Run integration tests - starts a real js-controller instance and verifies
// the adapter starts up cleanly. No live Leapmotor credentials are configured,
// so the adapter is expected to start, log a configuration/auth warning, and
// stay alive rather than crash.
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Adapter startup', getHarness => {
            it('should start without crashing', async function () {
                this.timeout(60000);

                const harness = getHarness();
                await harness.startAdapterAndWait();

                const isRunning = await harness.isAdapterRunning();
                expect(isRunning).to.be.true;
            });
        });
    },
});
