// The pinned MCP API accepts a caller-owned context but does not close the
// browser it launches itself. Keep ownership here so MCP DELETE/cancellation
// releases Chromium instead of leaving it alive until the idle timeout.
export async function createOwnedConnection({
  createConnection,
  chromium,
  settings,
}) {
  const owned = new Set();
  const disposals = new WeakMap();
  let context;
  let pending;
  let closed = false;
  let releasing;
  let closing;
  let idle;
  let connection;

  function dispose(browser) {
    let promise = disposals.get(browser);
    if (!promise) {
      promise = Promise.resolve()
        .then(() => browser.close({ reason: "Browser MCP session closed" }))
        .finally(() => owned.delete(browser));
      disposals.set(browser, promise);
    }
    return promise;
  }
  function release() {
    if (releasing) return releasing;
    closed = true;
    clearTimeout(idle);
    releasing = (async () => {
      // Close a browser even while newContext is pending. A launch that has
      // not returned yet observes closed and disposes its result itself.
      await Promise.allSettled([...owned].map(dispose));
      await pending?.catch(() => {});
      await Promise.allSettled([...owned].map(dispose));
    })();
    return releasing;
  }
  function touch() {
    clearTimeout(idle);
    if (!closed && (owned.size || pending)) {
      idle = setTimeout(
        () => void connection.close().catch(() => {}),
        settings.timeouts.idle,
      );
      idle.unref();
    }
  }
  async function getContext() {
    if (closed) throw new Error("Browser MCP session is closed");
    if (context) return context;
    if (!pending) {
      pending = (async () => {
        let browser;
        try {
          browser = await chromium.launch(settings.browser.launchOptions);
          owned.add(browser);
          if (closed) throw new Error("Browser MCP session is closed");
          const created = await browser.newContext(
            settings.browser.contextOptions,
          );
          if (closed) throw new Error("Browser MCP session is closed");
          context = created;
          created.once("close", () => {
            if (context === created) context = undefined;
            void dispose(browser).catch(() => {});
          });
          browser.once("disconnected", () => {
            if (context === created) context = undefined;
            owned.delete(browser);
          });
          touch();
          return created;
        } catch (error) {
          if (browser) await dispose(browser).catch(() => {});
          throw error;
        } finally {
          pending = undefined;
        }
      })();
    }
    return pending;
  }
  try {
    // false selects the supplied context in MCP's SimpleBrowser adapter.
    // The context above is freshly created with newContext, never persistent.
    connection = await createConnection(
      {
        ...settings,
        browser: { ...settings.browser, isolated: false },
      },
      getContext,
    );
  } catch (error) {
    await release();
    throw error;
  }
  const originalClose = connection.close.bind(connection);
  connection.close = () => {
    if (!closing) {
      const released = release();
      closing = (async () => {
        try {
          await originalClose();
        } finally {
          await released;
        }
      })();
    }
    return closing;
  };
  const onclose = connection.onclose;
  connection.onclose = () => {
    void release().catch(() => {});
    onclose?.();
  };
  const connect = connection.connect.bind(connection);
  connection.connect = async (transport) => {
    try {
      await connect(transport);
      const onmessage = transport.onmessage;
      transport.onmessage = (...args) => {
        touch();
        onmessage?.(...args);
      };
    } catch (error) {
      await connection.close();
      throw error;
    }
  };
  return connection;
}
