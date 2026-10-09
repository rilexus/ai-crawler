const { MarkItDown } = require("markitdown-ts");
// How long `waitFor` and the `findBy` methods wait, in milliseconds.
const DEFAULT_TIMEOUT = 10_000;

/**
 * A browser tab. `Browser.goto` creates one; every command sent through it
 * runs in that tab.
 */
class Page {
  /**
   * @param {import("./chrome").CDPConnection} connection The browser-level
   *   CDP connection the tab belongs to.
   * @param {string} targetId The tab's target ID.
   * @param {string} sessionId The session attached to the tab.
   */
  constructor(connection, targetId, sessionId) {
    this.connection = connection;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  /**
   * Sends a CDP command to this tab.
   *
   * @param {string} method The CDP method, for example `Runtime.evaluate`.
   * @param {object} [params] The command parameters.
   * @returns {Promise<any>}
   */
  send(method, params) {
    return this.connection.send(method, params, this.sessionId);
  }

  /**
   * Returns the page's rendered HTML, including the doctype.
   *
   * @returns {Promise<string>}
   */
  async content() {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression: `(document.doctype ? new XMLSerializer().serializeToString(document.doctype) : "") + document.documentElement.outerHTML`,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(`Failed to read the page HTML: ${exceptionDetails.text}`);
    }
    return result.value;
  }

  /**
   * Returns the page's current HTML, including the doctype and the content of
   * every open shadow root. Each shadow root appears as a
   * `<template shadowrootmode="open">` element inside its host, so a browser
   * that parses the HTML recreates it. Closed shadow roots are left out.
   *
   * @returns {Promise<string>}
   */
  async html() {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression: `(() => {
        const shadowRoots = [];
        const roots = [document];
        while (roots.length) {
          for (const element of roots.pop().querySelectorAll("*")) {
            if (element.shadowRoot) {
              shadowRoots.push(element.shadowRoot);
              roots.push(element.shadowRoot);
            }
          }
        }
        const doctype = document.doctype
          ? new XMLSerializer().serializeToString(document.doctype)
          : "";
        // getHTML returns only the inside of <html>, so add its tags back.
        const html = document.documentElement.cloneNode(false).outerHTML;
        const inner = document.documentElement.getHTML({ shadowRoots });
        return doctype + html.slice(0, -"</html>".length) + inner + "</html>";
      })()`,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(
        `Failed to read the page HTML: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
      );
    }
    return result.value;
  }

  /**
   * Converts the page's current HTML to Markdown with `markitdown-ts`.
   * Content inside shadow DOM isn't included, because `content` doesn't
   * include it.
   *
   * @returns {Promise<string>}
   * @throws If `markitdown-ts` can't convert the page.
   */
  async toMarkdown() {
    const [html, url] = await Promise.all([this.content(), this.url()]);
    // `url` lets it use its special converters for sites such as Wikipedia.
    const result = await new MarkItDown().convertBuffer(Buffer.from(html), {
      file_extension: ".html",
      url,
    });
    if (!result) throw new Error(`Failed to convert ${url} to Markdown.`);
    return result.markdown;
  }

  /**
   * Returns the address of the document the tab currently shows. Includes
   * changes the page makes without reloading, such as with
   * `history.pushState`.
   *
   * @returns {Promise<string>}
   */
  async url() {
    const { result } = await this.send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
    });
    return result.value;
  }

  /**
   * Finds the one element whose `id` is exactly `id`. Waits for it to appear.
   *
   * @param {string} id The element ID, without a leading `#`.
   * @param {object} [options]
   * @param {number} [options.timeout=10000] Milliseconds to wait for exactly
   *   one match to appear. Set to `0` to check once without waiting.
   * @returns {Promise<string>} The element's CDP `objectId`. Pass it to
   *   `Runtime.callFunctionOn` or `DOM` commands. It stops working once the
   *   page navigates.
   * @throws If, after `timeout`, no element or more than one element has
   *   this ID.
   */
  async findById(id, { timeout } = {}) {
    return this.#retry(
      () => this.#findOne(findAllById, [id], `with id "${id}"`),
      timeout,
    );
  }

  /**
   * Finds the one visible element whose text, as shown on screen, is `text`.
   * Runs of whitespace count as a single space, and leading and trailing
   * whitespace is ignored. Matching is case-sensitive and follows CSS
   * `text-transform`, so a button styled in capitals matches `"SAVE"`, not
   * `"Save"`.
   *
   * When an element and the elements around it all match, you get the
   * innermost one. For `<button><span>Save</span></button>`, that's the
   * `<span>`.
   *
   * Waits for the element to appear.
   *
   * @param {string} text The text to look for.
   * @param {object} [options]
   * @param {boolean} [options.exact=true] Whether the element's whole text
   *   must equal `text`. Set to `false` to match elements whose text contains
   *   `text`.
   * @param {number} [options.timeout=10000] Milliseconds to wait for exactly
   *   one match to appear. Set to `0` to check once without waiting.
   * @returns {Promise<string>} The element's CDP `objectId`.
   * @throws If, after `timeout`, no element or more than one element has
   *   this text.
   */
  async findByText(text, { exact = true, timeout } = {}) {
    return this.#retry(
      () =>
        this.#findOne(
          findAllByText,
          [text, exact],
          `${exact ? "with text" : "containing text"} ${JSON.stringify(text)}`,
        ),
      timeout,
    );
  }

  /**
   * Finds the one visible element whose `placeholder` attribute is `text`,
   * such as `<input placeholder="Search">` or a `<textarea>`. Whitespace is
   * normalized and matching is case-sensitive, as in `findByText`. Waits for
   * the element to appear.
   *
   * @param {string} text The placeholder to look for.
   * @param {object} [options]
   * @param {boolean} [options.exact=true] Whether the whole placeholder must
   *   equal `text`. Set to `false` to match placeholders that contain `text`.
   * @param {number} [options.timeout=10000] Milliseconds to wait for exactly
   *   one match to appear. Set to `0` to check once without waiting.
   * @returns {Promise<string>} The element's CDP `objectId`.
   * @throws If, after `timeout`, no element or more than one element has
   *   this placeholder.
   */
  async findByPlaceholderText(text, { exact = true, timeout } = {}) {
    return this.#retry(
      () =>
        this.#findOne(
          findAllByPlaceholderText,
          [text, exact],
          `${exact ? "with placeholder" : "with placeholder containing"} ${JSON.stringify(text)}`,
        ),
      timeout,
    );
  }

  /**
   * Finds the one visible element with an ARIA role, as the browser's
   * accessibility tree computes it. Implicit roles count, so a `<button>`
   * has role `button` and an `<input>` has role `textbox`, without a `role`
   * attribute. Searches inside shadow DOM too. Waits for the element to
   * appear.
   *
   * @param {string} role An ARIA role, such as `button`, `link`, `textbox`,
   *   `checkbox`, or `heading`.
   * @param {object} [options]
   * @param {string} [options.name] Text the element must be labeled with:
   *   its accessible name (from its content, `<label>`, `aria-label`, or
   *   `aria-labelledby`), or its `placeholder` or `aria-placeholder`.
   *   Whitespace is normalized and matching is case-sensitive.
   * @param {boolean} [options.exact=true] Whether `name` must equal the
   *   whole label. Set to `false` to match labels that contain `name`.
   * @param {number} [options.timeout=10000] Milliseconds to wait for exactly
   *   one match to appear. Set to `0` to check once without waiting.
   * @returns {Promise<string>} The element's CDP `objectId`.
   * @throws If, after `timeout`, no element or more than one element
   *   matches.
   */
  async findByRole(role, { name, exact = true, timeout } = {}) {
    return this.#retry(() => this.#findOneByRole(role, name, exact), timeout);
  }

  /**
   * Looks up `findByRole`'s element once, without waiting.
   *
   * @param {string} role
   * @param {string | undefined} name
   * @param {boolean} exact
   * @returns {Promise<string>}
   */
  async #findOneByRole(role, name, exact) {
    const description =
      name === undefined
        ? `with role "${role}"`
        : `with role "${role}" and ${exact ? "name" : "name containing"} ${JSON.stringify(name)}`;

    const { result: document } = await this.send("Runtime.evaluate", {
      expression: "document",
    });
    let nodes;
    try {
      ({ nodes } = await this.send("Accessibility.queryAXTree", {
        objectId: document.objectId,
        role,
      }));
    } finally {
      await this.send("Runtime.releaseObject", {
        objectId: document.objectId,
      }).catch(() => {});
    }

    const wanted = name === undefined ? undefined : normalize(name);
    const matches = nodes.filter((node) => {
      if (node.ignored || node.backendDOMNodeId === undefined) return false;
      if (wanted === undefined) return true;
      return accessibleLabels(node).some((label) =>
        exact ? label === wanted : label.includes(wanted),
      );
    });

    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `No element ${description}.`
          : `Found ${matches.length} elements ${description}. Expected exactly one.`,
      );
    }

    const { object } = await this.send("DOM.resolveNode", {
      backendNodeId: matches[0].backendDOMNodeId,
    });
    return object.objectId;
  }

  /**
   * Retries a single-attempt lookup until it succeeds or `timeout` passes.
   *
   * @template T
   * @param {() => Promise<T>} lookup
   * @param {number} [timeout=10000] Set to `0` to try once.
   * @returns {Promise<T>}
   */
  async #retry(lookup, timeout = DEFAULT_TIMEOUT) {
    return timeout > 0 ? this.waitFor(lookup, { timeout }) : lookup();
  }

  /**
   * Runs `finder` in the page and returns the `objectId` of its only match.
   *
   * @param {Function} finder A function that runs in the page and returns
   *   the matching elements. It can't use variables from Node, except
   *   `querySelectorAllDeep` and `keepInnermost`.
   * @param {any[]} args JSON-serializable arguments for `finder`.
   * @param {string} description Describes the match for error messages.
   * @returns {Promise<string>}
   */
  async #findOne(finder, args, description) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression: `(() => {
        const querySelectorAllDeep = ${querySelectorAllDeep};
        const keepInnermost = ${keepInnermost};
        const matches = (${finder})(...${JSON.stringify(args)});
        return matches.length === 1 ? matches[0] : matches.length;
      })()`,
    });
    if (exceptionDetails) {
      throw new Error(
        `Failed to find an element ${description}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
      );
    }

    if (result.type === "number") {
      throw new Error(
        result.value === 0
          ? `No element ${description}.`
          : `Found ${result.value} elements ${description}. Expected exactly one.`,
      );
    }
    return result.objectId;
  }

  /**
   * Calls `callback` until it returns without throwing, and returns its
   * result. Use it to wait for an element that the page adds or shows
   * later, such as one in a dialog that's still opening.
   *
   * @template T
   * @param {() => Promise<T>} callback Throws while the condition isn't met,
   *   as the `findBy` methods do when nothing matches.
   * @param {object} [options]
   * @param {number} [options.timeout=10000] Milliseconds to keep trying.
   * @param {number} [options.interval=100] Milliseconds between attempts.
   * @returns {Promise<T>}
   * @throws If `callback` still throws after `timeout`. The message includes
   *   the last error, which is also set as `cause`.
   */
  async waitFor(callback, { timeout = DEFAULT_TIMEOUT, interval = 100 } = {}) {
    const deadline = Date.now() + timeout;
    let lastError;

    while (true) {
      // Bound each attempt too, so a callback that hangs can't outlast the
      // timeout.
      const cutOff = new Error("The attempt didn't finish in time.");
      let timer;
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(cutOff),
          Math.max(deadline - Date.now(), 0),
        );
      });
      try {
        return await Promise.race([callback(), timedOut]);
      } catch (error) {
        // An attempt cut off at the deadline says less than the error before
        // it, such as "No element with role…".
        if (error !== cutOff || !lastError) lastError = error;
      } finally {
        clearTimeout(timer);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out after ${timeout} ms. Last error: ${lastError?.message ?? lastError}`,
          { cause: lastError },
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(interval, remaining)),
      );
    }
  }

  /**
   * Clicks an element with the mouse, the way a person would: scrolls it
   * into view, moves the pointer to its center, and presses and releases the
   * left button there.
   *
   * @param {string} element The element's `objectId`, from `findById`.
   * @throws If the element isn't displayed, has no visible area, or another
   *   element covers its center.
   */
  async click(element) {
    try {
      await this.send("DOM.scrollIntoViewIfNeeded", { objectId: element });
    } catch (error) {
      throw new Error("Can't click an element that isn't displayed.", {
        cause: error,
      });
    }

    // Quads follow CSS transforms. An inline element that wraps has one per
    // line; click the first.
    const { quads } = await this.send("DOM.getContentQuads", {
      objectId: element,
    });
    const quad = quads.find((points) => quadArea(points) > 1);
    if (!quad) throw new Error("Can't click an element with no visible area.");

    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;

    // The mouse hits whatever is on top, so make sure that's the element or
    // something inside it, not an overlay such as a cookie banner.
    const { result } = await this.send("Runtime.callFunctionOn", {
      objectId: element,
      functionDeclaration: `function (x, y) {
        // The document reports a shadow host in place of anything inside it,
        // so descend into shadow roots to find the element actually hit.
        let hit = document.elementFromPoint(x, y);
        while (hit?.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === hit) break;
          hit = inner;
        }
        // Walk up the rendered tree, crossing slots and shadow roots.
        for (let node = hit; node; node = node.assignedSlot ?? node.parentNode ?? node.host) {
          if (node === this) return null;
        }
        return hit ? hit.outerHTML.slice(0, 100) : null;
      }`,
      arguments: [{ value: x }, { value: y }],
      returnByValue: true,
    });
    if (result.value) {
      throw new Error(
        `Can't click the element because another element covers it: ${result.value}`,
      );
    }

    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    }
  }

  /**
   * Enters text into a text field: an `<input>`, a `<textarea>`, or a
   * `contenteditable` element such as a rich-text editor. Focuses the field
   * and inserts the text the way typing or pasting would, so the page gets
   * `beforeinput` and `input` events.
   *
   * @param {string} element The field's `objectId`, from a `findBy` method.
   *   An element inside a `contenteditable` region works too.
   * @param {string} text The text to enter.
   * @param {object} [options]
   * @param {boolean} [options.replace=false] Whether to replace the field's
   *   current text. By default, the text goes at the end.
   * @throws If the element isn't a text field, or is disabled or read-only.
   */
  async type(element, text, { replace = false } = {}) {
    const { result } = await this.send("Runtime.callFunctionOn", {
      objectId: element,
      functionDeclaration: `function (replace) {
        const isField = this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement;
        if (!isField && !this.isContentEditable) {
          return "The element isn't a text field: " + this.outerHTML.slice(0, 100);
        }
        if (this.disabled || this.readOnly) return "The text field is disabled or read-only.";

        if (isField) {
          this.focus();
          if (replace) {
            this.select();
          } else {
            // Some input types, such as email, can't move the cursor. Focus
            // leaves it at the end anyway.
            try {
              this.setSelectionRange(this.value.length, this.value.length);
            } catch {}
          }
        } else {
          // Focus the editing host, the outermost editable ancestor.
          let host = this;
          while (host.parentElement?.isContentEditable) host = host.parentElement;
          host.focus();
          const range = document.createRange();
          range.selectNodeContents(this);
          if (!replace) range.collapse(false);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return null;
      }`,
      arguments: [{ value: replace }],
      returnByValue: true,
    });
    if (result.value) throw new Error(result.value);

    if (text) {
      await this.send("Input.insertText", { text });
    } else if (replace) {
      // Inserting nothing doesn't clear a selection, so press Backspace.
      for (const type of ["rawKeyDown", "keyUp"]) {
        await this.send("Input.dispatchKeyEvent", {
          type,
          key: "Backspace",
          code: "Backspace",
          windowsVirtualKeyCode: 8,
        });
      }
    }
  }

  /**
   * Closes the tab. Does nothing if it's already closed.
   */
  async close() {
    await this.connection
      .send("Target.closeTarget", { targetId: this.targetId })
      .catch(() => {});
  }
}

/**
 * Collapses runs of whitespace into single spaces and trims the ends.
 *
 * @param {string} value
 * @returns {string}
 */
function normalize(value) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Returns the texts an accessibility node is labeled with: its accessible
 * name, plus its `placeholder` and `aria-placeholder`. Chrome reports
 * placeholders as name sources even when a label takes precedence.
 *
 * @param {object} node A CDP `Accessibility.AXNode`.
 * @returns {string[]}
 */
function accessibleLabels(node) {
  const labels = [node.name?.value];
  for (const source of node.name?.sources ?? []) {
    if (source.type === "placeholder")
      labels.push(source.attributeValue?.value);
  }
  return labels
    .filter((label) => typeof label === "string")
    .map(normalize)
    .filter(Boolean);
}

// The functions below run inside the page, not in Node.

/**
 * Returns every element matching `selector` in the document and in all open
 * shadow roots, at any depth. Closed shadow roots can't be searched.
 *
 * @param {string} selector
 * @returns {Element[]}
 */
function querySelectorAllDeep(selector) {
  const matches = [];
  const roots = [document];
  while (roots.length) {
    const root = roots.pop();
    matches.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  return matches;
}

/**
 * Removes elements that contain another element from `elements`, looking
 * through shadow roots too. When a text or placeholder matches, so do the
 * elements around it, and only the innermost one is wanted.
 *
 * @param {Element[]} elements
 * @returns {Element[]}
 */
function keepInnermost(elements) {
  const ancestors = new Set();
  for (const element of elements) {
    // Unlike `parentElement`, this steps from a shadow root to its host.
    let node = element.parentNode ?? element.host;
    for (; node; node = node.parentNode ?? node.host) ancestors.add(node);
  }
  return elements.filter((element) => !ancestors.has(element));
}

/**
 * Returns every element whose `id` is exactly `id`, including inside shadow
 * DOM. Unlike `getElementById`, it doesn't stop at the first of several
 * duplicates.
 *
 * @param {string} id
 * @returns {Element[]}
 */
function findAllById(id) {
  return querySelectorAllDeep(`[id="${CSS.escape(id)}"]`);
}

/**
 * Returns the innermost visible elements, including inside shadow DOM, whose
 * on-screen text equals, or contains, `text`.
 *
 * @param {string} text
 * @param {boolean} exact
 * @returns {Element[]}
 */
function findAllByText(text, exact) {
  const normalize = (value) => value.replace(/\s+/g, " ").trim();
  // `innerText` matches the screen but needs layout, so first rule out
  // elements cheaply. Ignore case and whitespace, which `text-transform` and
  // block layout can change.
  const squash = (value) => value.replace(/\s+/g, "").toLowerCase();
  const wanted = normalize(text);
  const squashedWanted = squash(wanted);

  const matches = [];
  for (const element of querySelectorAllDeep("*")) {
    if (!squash(element.textContent).includes(squashedWanted)) continue;
    if (!element.checkVisibility()) continue;

    // SVG elements have no `innerText`.
    const shown = normalize(element.innerText ?? element.textContent);
    if (exact ? shown === wanted : shown.includes(wanted)) {
      matches.push(element);
    }
  }

  return keepInnermost(matches);
}

/**
 * Returns the innermost visible elements, including inside shadow DOM, whose
 * `placeholder` equals, or contains, `text`.
 *
 * Components often copy their `placeholder` onto the field in their shadow
 * root, as in `<search-input placeholder="Search">` wrapping
 * `<textarea placeholder="Search">`. Only the field is returned.
 *
 * @param {string} text
 * @param {boolean} exact
 * @returns {Element[]}
 */
function findAllByPlaceholderText(text, exact) {
  const normalize = (value) => value.replace(/\s+/g, " ").trim();
  const wanted = normalize(text);

  const matches = querySelectorAllDeep("[placeholder]").filter((element) => {
    if (!element.checkVisibility()) return false;
    const placeholder = normalize(element.getAttribute("placeholder"));
    return exact ? placeholder === wanted : placeholder.includes(wanted);
  });

  return keepInnermost(matches);
}

/**
 * Returns the area of a quad given as `[x1, y1, x2, y2, x3, y3, x4, y4]`.
 *
 * @param {number[]} quad
 * @returns {number}
 */
function quadArea(quad) {
  let area = 0;
  for (let i = 0; i < 8; i += 2) {
    const j = (i + 2) % 8;
    area += quad[i] * quad[j + 1] - quad[j] * quad[i + 1];
  }
  return Math.abs(area / 2);
}

module.exports = Page;
