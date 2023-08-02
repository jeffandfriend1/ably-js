import { BaseRest, BaseRealtime, Rest } from '../../build/modules/index.js';

describe('browser/modules', function () {
  this.timeout(10 * 1000);
  const expect = chai.expect;
  let ablyClientOptions;

  before((done) => {
    ablyClientOptions = window.ablyHelpers.ablyClientOptions;
    window.ablyHelpers.setupApp(done);
  });

  describe('without any modules', () => {
    for (const clientClass of [BaseRest, BaseRealtime]) {
      describe(clientClass.name, () => {
        it('can be constructed', async () => {
          expect(() => new clientClass(ablyClientOptions(), {})).not.to.throw;
        });
      });
    }
  });

  describe('Rest', () => {
    describe('BaseRest without explicit Rest', () => {
      it('offers REST functionality', async () => {
        const client = new BaseRest(ablyClientOptions(), { Rest });
        const time = await client.time();
        expect(time).to.be.a('number');
      });
    });

    describe('BaseRealtime with Rest', () => {
      it('offers REST functionality', async () => {
        const client = new BaseRealtime(ablyClientOptions(), { Rest });
        const time = await client.time();
        expect(time).to.be.a('number');
      });
    });

    describe('BaseRealtime without Rest', () => {
      it('throws an error when attempting to use REST functionality', async () => {
        const client = new BaseRealtime(ablyClientOptions(), {});
        expect(() => client.time()).to.throw();
      });
    });
  });
});
