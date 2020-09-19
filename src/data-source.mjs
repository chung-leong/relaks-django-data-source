import { EventEmitter } from 'relaks-event-emitter';
import { DataSourceError } from './data-source-error.mjs';
import { DataSourceEvent } from './data-source-event.mjs';

const defaultOptions = {
  baseURL: '',
  refreshInterval: 0,
  authorizationKeyword: 'Token',
  abbreviatedFolderContents: false,
  forceHTTPS: true,
  fetchFunc: null,
};

class RelaksDjangoDataSource extends EventEmitter {
  constructor(options) {
    super();
    this.active = false;
    this.activationPromise = null;
    this.queries = [];
    this.authentications = [];
    this.authorizations = [];
    this.options = {};
    for (let name in defaultOptions) {
      if (options && options[name] !== undefined) {
        this.options[name] = options[name];
      } else {
        this.options[name] = defaultOptions[name];
      }
    }
  }

  /**
   * Activate the component
   */
  activate() {
    if (!this.active) {
      this.active = true;
      if (this.activationPromise) {
        const { resolve } = this.activationPromise;
        this.activationPromise = null;
        resolve();
      }
      this.startExpirationCheck();
      this.checkExpiration();
    }
  }

  /**
   * Deactivate the component
   */
  deactivate() {
    if (this.active) {
      this.stopExpirationCheck();
      this.active = false;
    }
  }

  /**
   * Add baseURL to relative URL
   *
   * @param  {String} url
   *
   * @return {String}
   */
  resolveURL(url) {
    if (typeof(url) !== 'string') {
      return url;
    }
    let { baseURL } = this.options;
    if (baseURL && !/^https?:/.test(url)) {
      if (!/^https?:/.test(baseURL)) {
        if (typeof(location) === 'object') {
          const { protocol, host } = location;
          baseURL = `${protocol}//${host}${baseURL}`;
        } else {
          if (process.env.NODE_ENV !== 'production') {
            console.warn('Base URL is not absolute');
          }
        }
      }
      url = removeTrailingSlash(baseURL) + addLeadingSlash(url);
    }
    if (this.options.forceHTTPS) {
      if (baseURL && /^https:/.test(baseURL)) {
        url = url.replace(/http:/, 'https:');
      }
    }
    url = addTrailingSlash(url);
    return url;
  }

  /**
   * Resolve a list of URLs
   *
   * @param  {Array<String>} urls
   *
   * @return {Array<String>}
   */
  resolveURLs(urls) {
    return urls.map(url => this.resolveURL(url));
  }


  /**
   * Trigger a 'change' event unless changed is false
   *
   * @param  {Boolean} changed
   *
   * @return {Boolean}
   */
  notifyChanges(changed) {
    if (changed === false) {
      return false;
    }
    this.triggerEvent(new DataSourceEvent('change', this));
    return true;
  }

  /**
   * Fetch one object at the URL.
   *
   * @param  {String} url
   * @param  {Object|undefined} options
   *
   * @return {Promise<Object>}
   */
  fetchOne(url, options) {
    const absURL = this.resolveURL(url);
    const props = {
      type: 'object',
      url: absURL,
      options: options || {},
    };
    let query = this.findQuery(props);
    if (!query) {
      query = this.deriveQuery(absURL, true);
    }
    if (!query) {
      const time = getTime();
      query = props;
      query.promise = this.get(absURL).then((response) => {
        const object = response;
        query.object = object;
        query.time = time;
        this.processFreshObject(object, absURL, query, true);
        return object;
      });
      this.queries.unshift(query);
    }
    return query.promise.then((object) => {
      if (query.expired)  {
        this.refreshOne(query);
      }
      return object;
    });
  }

  /**
   * Fetch a page of objects
   *
   * @param  {String} url
   * @param  {Number} page
   * @param  {Object|undefined} options
   *
   * @return {Promise<Array>}
   */
  fetchPage(url, page, options) {
    const absURL = this.resolveURL(url);
    const props = {
      type: 'page',
      url: absURL,
      page: page,
      options: options || {},
    };
    let query = this.findQuery(props);
    if (!query) {
      const pageURL = attachPageNumber(absURL, page);
      const time = getTime();
      query = props;
      query.promise = this.get(pageURL).then((response) => {
        let objects, total;
        if (response instanceof Array) {
          objects = response;
          total = objects.length;
        } else {
          objects = response.results;
          total = response.count;
        }
        objects.total = total;
        query.objects = objects;
        query.time = time;
        this.processFreshObjects(objects, pageURL, query, true);
        return objects;
      });
      this.queries.push(query);
    }
    return query.promise.then((objects) => {
      if (query.expired)  {
        this.refreshPage(query);
      }
      return objects;
    });
  }

  /**
   * Fetch a list of objects at the given URL.
   *
   * @param  {String} url
   * @param  {Object} options
   *
   * @return {Promise<Array>}
   */
  fetchList(url, options) {
    const absURL = this.resolveURL(url);
    const props = {
      type: 'list',
      url: absURL,
      options: options || {},
    };
    let query = this.findQuery(props);
    if (!query) {
      query = props;
      query.promise = this.fetchNextPage(query, true);
      this.queries.push(query);
    }
    return query.promise.then((objects) => {
      if (query.expired)  {
        this.refreshList(query);
      }
      return objects;
    });
  }

  /**
   * Return what has been fetched. Used by fetchList().
   *
   * @param  {Object} query
   *
   * @return {Promise<Array>}
   */
  fetchNoMore(query) {
    return query.promise;
  }

  /**
   * Initiate fetching of the next page. Used by fetchList().
   *
   * @param  {Object} query
   * @param  {Boolean} initial
   *
   * @return {Promise<Array>}
   */
  fetchNextPage(query, initial) {
    if (query.nextPromise) {
      return query.nextPromise;
    }
    const time = getTime();
    const nextURL = (initial) ? query.url : query.nextURL;
    const nextPromise = this.get(nextURL).then((response) => {
      if (response instanceof Array) {
        // the full list is returned
        const objects = response;
        objects.more = this.fetchNoMore.bind(this, query);
        objects.total = objects.length;
        query.objects = objects;
        query.time = time;
        query.nextPromise = null;
        this.processFreshObjects(objects, nextURL, query, true);
        return objects;
      } else if (response instanceof Object) {
        // append retrieved objects to list
        const total = response.count;
        const freshObjects = response.results;
        const objects = appendObjects(query.objects, freshObjects);
        query.objects = objects;
        query.promise = nextPromise;
        query.nextPromise = null;
        query.nextURL = this.resolveURL(response.next);
        query.nextPage = (query.nextPage || 1) + 1;
        if (initial) {
          query.time = time;
        }
        this.processFreshObjects(freshObjects, nextURL, query, initial);

        // attach function to results so caller can ask for more results
        if (query.nextURL) {
          objects.more = this.fetchNextPage.bind(this, query, false);
          objects.total = total;

          // if minimum is provide, fetch more if it's not met
          const minimum = getMinimum(query.options, total, NaN);
          if (objects.length < minimum) {
            // fetch the next page
            return this.fetchNextPage(query, false);
          }
        } else {
          objects.more = this.fetchNoMore.bind(this, query);
          objects.total = objects.length;
        }

        // inform parent component that more data is available
        this.notifyChanges(!initial);
        return objects;
      }
    }).catch((err) => {
      if (!initial) {
        query.nextPromise = null;
      }
      throw err;
    });
    if (!initial) {
      query.nextPromise = nextPromise;
    }
    return nextPromise;
  }

  /**
   * Fetch multiple JSON objects. If minimum is specified, then immediately
   * resolve with cached results when there're sufficient numbers of objects.
   * An onChange will be trigger once the full set is retrieved.
   *
   * @param  {Array<String>} urls
   * @param  {Object} options
   *
   * @return {Promise<Array>}
   */
  fetchMultiple(urls, options) {
    // see which ones are cached already
    let cached = 0;
    const fetchOptions = {};
    for (let name in options) {
      if (name !== 'minimum') {
        fetchOptions[name] = options[name];
      }
    }
    const cachedResults = [];
    const promises = [];
    for (let url of urls) {
      const absURL = this.resolveURL(url);
      const props = {
        url: absURL,
        type: 'object',
        options: fetchOptions
      };
      let query = this.findQuery(props);
      if (!query) {
        query = this.deriveQuery(absURL, true);
      }
      if (query && query.object) {
        cached++;
        cachedResults.push(query.object);
        promises.push(query.object);
      } else {
        cachedResults.push(null);
        promises.push(this.fetchOne(absURL, fetchOptions));
      }
    }

    // wait for the complete list to arrive
    let completeListPromise;
    if (cached < urls.length) {
      completeListPromise = this.waitForResults(promises).then((outcome) => {
        if (outcome.error) {
          throw outcome.error;
        }
        return outcome.results;
      });
    }

    // see whether partial result set should be immediately returned
    const minimum = getMinimum(options, urls.length, urls.length);
    if (cached < minimum && completeListPromise) {
      return completeListPromise;
    } else {
      if (completeListPromise) {
        // return partial list then fire change event when complete list arrives
        completeListPromise.then((objects) => {
          this.notifyChanges(true);
        });
      }
      return Promise.resolve(cachedResults);
    }
  }

  /**
   * Reperform an query for an object, triggering an onChange event if the
   * object has changed.
   *
   * @param  {Object} query
   */
  refreshOne(query) {
    if (query.refreshing) {
      return;
    }
    query.refreshing = true;

    const time = getTime();
    this.get(query.url).then((response) => {
      const object = response;
      query.time = time;
      query.refreshing = false;
      query.expired = false;
      if (!matchObject(object, query.object)) {
        query.object = object;
        query.promise = Promise.resolve(object);
        this.processFreshObject(object, query.url, query, false);
        this.notifyChanges(true);
      }
    }).catch((err) => {
      query.refreshing = false;
    });
  }

  /**
   * Reperform an query for a page of objects, triggering an onChange event if
   * the list is different from the one fetched previously.
   *
   * @param  {Object} query
   */
  refreshPage(query) {
    if (query.refreshing) {
      return;
    }
    query.refreshing = true;

    const time = getTime();
    const pageURL = attachPageNumber(query.url, query.page);
    this.get(pageURL).then((response) => {
      let objects, total;
      if (response instanceof Array) {
        objects = response;
        total = response.length;
      } else {
        objects = response.results
        total = response.count;
      }

      // remove other pages (unless they're refreshing)
      const otherQueries = [];
      for (let otherQuery of this.queries) {
        if (otherQuery.url === query.url) {
          if (otherQuery.page !== query.page) {
            if (otherQuery.expired && !otherQuery.refreshing) {
              otherQueries.push(otherQuery);
            }
          }
        }
      }
      pullObjects(this.queries, otherQueries);
      setTimeout(() => {
        for (let { url, page, options } of otherQueries) {
          this.fetchPage(url, page, options);
        }
      }, 1000);

      query.time = time;
      query.refreshing = false;
      query.expired = false;
      const freshObjects = replaceIdentificalObjects(objects, query.objects);
      if (freshObjects) {
        objects.total = total;
        query.objects = objects;
        query.promise = Promise.resolve(objects);
        this.processFreshObjects(freshObjects, pageURL, query, false);
        this.notifyChanges(true);
      }
    }).catch((err) => {
      query.refreshing = false;
    });
  }

  /**
   * Reperform an query for a list of objects, triggering an onChange event if
   * the list is different from the one fetched previously.
   *
   * @param  {Object} query
   */
  refreshList(query) {
    if (query.refreshing) {
      return;
    }
    query.refreshing = true;

    if (query.nextPage) {
      // updating paginated list
      // wait for any call to more() to finish first
      Promise.resolve(query.nextPromise).then(() => {
        // suppress fetching of additional pages for the time being
        const oldObjects = query.objects;
        let morePromise, moreResolve, moreReject;
        const fetchMoreAfterward = () => {
          if (!morePromise) {
            morePromise = new Promise((resolve, reject) => {
              moreResolve = resolve;
              moreReject = reject;
            });
          }
          return morePromise;
        };
        oldObjects.more = fetchMoreAfterward;

        let refreshedObjects;
        let pageRemaining = query.nextPage - 1;
        let nextURL = query.url;

        const refreshNextPage = () => {
          return this.get(nextURL).then((response) => {
            pageRemaining--;
            nextURL = this.resolveURL(response.next);
            if (pageRemaining === 0) {
              // set query.nextURL to the URL given by the server
              // in the event that new pages have become available
              query.nextURL = nextURL;
            }
            refreshedObjects = appendObjects(refreshedObjects, response.results);

            const total = response.count;
            const objects = joinObjectLists(refreshedObjects, oldObjects);
            const freshObjects = replaceIdentificalObjects(objects, query.objects);
            if (freshObjects) {
              objects.total = total;
              objects.more = fetchMoreAfterward;
              query.objects = objects;
              query.promise = Promise.resolve(objects);
              this.processFreshObjects(freshObjects, query.url, query, false);
              this.notifyChanges(true);
            }

            // keep going until all pages have been updated
            if (query.nextURL !== nextURL) {
              return refreshNextPage();
            }
          });
        };

        const time = getTime();
        refreshNextPage().then(() => {
          // we're done
          query.time = time;
          query.refreshing = false;
          query.expired = false;

          // reenable fetching of additional pages
          if (query.nextURL) {
            query.objects.more = this.fetchNextPage.bind(this, query, false);
          } else {
            query.objects.more = this.fetchNoMore.bind(this, query);
          }

          // trigger it if more() had been called
          if (morePromise) {
            query.objects.more().then(moreResolve, moreReject);
          }
        }).catch((err) => {
          query.refreshing = false;
        });
      });
    } else {
      // updating un-paginated list
      const time = getTime();
      this.get(query.url).then((response) => {
        const objects = response;
        query.time = time;
        query.refreshing = false;
        query.expired = false;
        const freshObjects = replaceIdentificalObjects(objects, query.objects);
        if (freshObjects) {
          objects.more = this.fetchNoMore.bind(this, query);
          objects.total = objects.length;
          query.objects = objects;
          query.promise = Promise.resolve(objects);
          this.processFreshObjects(freshObjects, query.url, query, false);
          this.notifyChanges(true);
        }
      }).catch((err) => {
        query.refreshing = false;
        throw err;
      });
    }
  }

  processFreshObject(object, objectURL, excludeQuery, notify) {
    const op = {
      url: getFolderURL(objectURL),
      results: [ object ],
      rejects: [],
      query: excludeQuery,
    };
    const changed = this.runUpdateHooks(op);
    if (notify)  {
      this.notifyChanges(changed);
    }
    return changed;
  }

  processFreshObjects(objects, folderURL, excludeQuery, notify) {
    const op = {
      url: omitSearchString(folderURL),
      results: objects,
      rejects: [],
      query: excludeQuery,
    };
    const changed = this.runUpdateHooks(op);
    if (notify)  {
      this.notifyChanges(changed);
    }
    return changed;
  }

  /**
   * Insert an object into remote database
   *
   * @param  {String} folderURL
   * @param  {Object} object
   *
   * @return {Promise<Object>}
   */
  insertOne(folderURL, object) {
    return this.insertMultiple(folderURL, [ object ]).then((insertedObjects) => {
      return insertedObjects[0];
    });
  }

  /**
   * Insert multiple objects into remote database
   *
   * @param  {String} folderURL
   * @param  {Array<Object>} objects
   *
   * @return {Promise<Array>}
   */
  insertMultiple(folderURL, objects) {
    const folderAbsURL = this.resolveURL(folderURL);
    const promises = objects.map(object => this.post(folderAbsURL, object));
    return this.waitForResults(promises).then((outcome) => {
      let changed = false;
      const ops = segregateResults(folderAbsURL, objects, outcome);
      for (let op of ops) {
        if (this.runInsertHooks(op)) {
          changed = true;
        }
      }
      this.notifyChanges(changed);
      if (outcome.error) {
        throw outcome.error;
      }
      return outcome.results;
    });
  }

  /**
   * Update an object
   *
   * @param  {String} folderURL
   * @param  {Object} object
   *
   * @return {Promise<Object>}
   */
  updateOne(folderURL, object) {
    // allow folderURL to be omitted
    if (object === undefined && folderURL instanceof Object) {
      object = folderURL;
      folderURL = null;
    }
    return this.updateMultiple(folderURL, [ object ]).then((results) => {
      return results[0];
    });
  }

  /**
   * Update multiple objects
   *
   * @param  {String} folderURL
   * @param  {Array<Object>} objects
   *
   * @return {Promise<Array>}
   */
  updateMultiple(folderURL, objects) {
    // allow folderURL to be omitted
    if (objects === undefined && folderURL instanceof Array) {
      objects = folderURL;
      folderURL = null;
    }
    const folderAbsURL = this.resolveURL(folderURL);
    const promises = objects.map((object) => {
      const absURL = getObjectURL(folderAbsURL, object);
      return this.put(absURL, object);
    });
    return this.waitForResults(promises).then((outcome) => {
      let changed = false;
      const ops = segregateResults(folderAbsURL, objects, outcome);
      for (let op of ops) {
        if (this.runUpdateHooks(op)) {
          changed = true;
        }
      }
      this.notifyChanges(changed);
      if (outcome.error) {
        throw outcome.error;
      }
      return outcome.results;
    });
  }

  /**
   * Delete an object
   *
   * @param  {String} folderURL
   * @param  {Object} object
   *
   * @return {Promise<Object>}
   */
  deleteOne(folderURL, object) {
    // allow folderURL to be omitted
    if (object === undefined && folderURL instanceof Object) {
      object = folderURL;
      folderURL = null;
    }
    return this.deleteMultiple(folderURL, [ object ]).then((results) => {
      return results[0];
    });
  }

  /**
   * Delete multiple objects
   *
   * @param  {String} folderURL
   * @param  {Array<Object>} objects
   *
   * @return {Promise<Array>}
   */
  deleteMultiple(folderURL, objects) {
    // allow folderURL to be omitted
    if (objects === undefined && folderURL instanceof Array) {
      objects = folderURL;
      folderURL = null;
    }
    const folderAbsURL = this.resolveURL(folderURL);
    const promises = objects.map((object) => {
      const absURL = getObjectURL(folderAbsURL, object);
      return this.delete(absURL, object).then(() => {
        // create copy of object, as a DELETE op does not return anything
        return cloneObject(object);
      });
    });
    return this.waitForResults(promises).then((outcome) => {
      let changed = false;
      const ops = segregateResults(folderAbsURL, objects, outcome);
      for (let op of ops) {
        if (this.runDeleteHooks(op)) {
          changed = true;
        }
      }
      this.notifyChanges(changed);
      if (outcome.error) {
        throw outcome.error;
      }
      return outcome.results;
    });
  }

  /**
   * Run insert hooks
   *
   * @param  {Object} op
   *
   * @return {Boolean}
   */
  runInsertHooks(op) {
    let changed = false;
    for (let query of this.queries) {
      if (query !== op.query) {
        if (this.runInsertHook(query, op)) {
          changed = true;
        }
      }
    }
    if (op.results) {
      const time = getTime();
      for (let newObject of op.results) {
        const absURL = getObjectURL(op.url, newObject);
        const query = {
          type: 'object',
          url: absURL,
          promise: Promise.resolve(newObject),
          object: newObject,
          time: time,
        };
        this.queries.unshift(query);
      }
    }
    return changed;
  }

  /**
   * Run a query's insert hook if its URL matches
   *
   * @param  {Object} query
   * @param  {Object} op
   *
   * @return {Boolean}
   */
  runInsertHook(query, op) {
    if (query.type === 'page' || query.type === 'list') {
      const defaultBehavior = 'refresh';
      const queryFolderURL = omitSearchString(query.url);
      if (queryFolderURL === op.url) {
        if (op.rejects) {
          query.expired = true;
          return true;
        }
        if (op.results) {
          const newObjects = excludeObjects(op.results, query.objects);
          if (newObjects) {
            return runHook(query, 'afterInsert', newObjects, defaultBehavior);
          }
        }
      }
    }
    return false;
  }

  /**
   * Run afterUpdate hooks
   *
   * @param  {Object} op
   *
   * @return {Boolean}
   */
  runUpdateHooks(op) {
    let changed = false;
    for (let query of this.queries) {
      if (query !== op.query) {
        if (this.runUpdateHook(query, op)) {
          changed = true;
        }
      }
    }
    return changed;
  }

  /**
   * Run a query's afterUpdate hook if its URL matches
   *
   * @param  {Object} query
   * @param  {Object} op
   *
   * @return {Boolean}
   */
  runUpdateHook(query, op) {
    if (query.type === 'object') {
      const defaultBehavior = 'replace';
      const queryFolderURL = getFolderURL(query.url);
      if (queryFolderURL === op.url) {
        if (op.rejects) {
          const rejectedObject = findObject(op.rejects, query.object);
          if (rejectedObject) {
            query.expired = true;
            return true;
          }
        }
        if (op.results) {
          const modifiedObject = findObject(op.results, query.object, true);
          if (modifiedObject) {
            return runHook(query, 'afterUpdate', modifiedObject, defaultBehavior);
          }
        }
      }
    } else if (query.type === 'page' || query.type === 'list') {
      const defaultBehavior = 'refresh';
      const queryFolderURL = omitSearchString(query.url);
      if (queryFolderURL === op.url) {
        if (op.rejects) {
          const rejectedObjects = findObjects(op.rejects, query.objects);
          if (rejectedObjects) {
            query.expired = true;
            return true;
          }
        }
        if (op.results) {
          const modifiedObjects = findObjects(op.results, query.objects, true);
          if (modifiedObjects) {
            return runHook(query, 'afterUpdate', modifiedObjects, defaultBehavior);
          }
        }
      }
    }
    return false;
  }

  /**
   * Run afterDelete hooks
   *
   * @param  {Object} op
   *
   * @return {Boolean}
   */
  runDeleteHooks(op) {
    let changed = false;
    const removing = [];
    for (let query of this.queries) {
      if (query !== op.query) {
        if (this.runDeleteHook(query, op)) {
          changed = true;
          if (query.expired && query.type === 'object') {
            removing.push(query);
            continue;
          }
        }
      }
    }
    pullObjects(this.queries, removing);
    return changed;
  }

  /**
   * Run a query's afterDelete hook if its URL matches
   *
   * @param  {Object} query
   * @param  {Object} op
   *
   * @return {Boolean}
   */
  runDeleteHook(query, op) {
    if (query.type === 'object') {
      const defaultBehavior = 'remove';
      const queryFolderURL = getFolderURL(query.url);
      if (queryFolderURL === op.url) {
        if (op.rejects) {
          const rejectedObject = findObject(op.rejects, query.object);
          if (rejectedObject) {
            query.expired = true;
            return true;
          }
        }
        if (op.results) {
          const deletedObject = findObject(op.results, query.object);
          if (deletedObject) {
            return runHook(query, 'afterDelete', deletedObject, defaultBehavior);
          }
        }
      }
    } else if (query.type === 'page' || query.type === 'list') {
      const defaultBehavior = (query.type === 'list') ? 'remove' : 'refresh';
      const queryFolderURL = omitSearchString(query.url);
      if (queryFolderURL === op.url) {
        if (op.rejects) {
          const rejectedObjects = findObjects(op.rejects, query.objects);
          if (rejectedObjects) {
            query.expired = true;
            return true;
          }
        }
        if (op.results) {
          const deletedObjects = findObjects(op.results, query.objects);
          if (deletedObjects) {
            return runHook(query, 'afterDelete', deletedObjects, defaultBehavior);
          }
        }
      }
    }
    return false;
  }

  /**
   * Mark matching queries as expired
   *
   * @param  {String|Date} time
   *
   * @return {Boolean}
   */
  invalidate(time) {
    if (time instanceof Date) {
      time = time.toISOString();
    }
    let changed = false;
    for (let query of this.queries) {
      if (!query.expired) {
        if (!time || query.time <= time) {
          query.expired = true;
          changed = true;
        }
      }
    }
    return this.notifyChanges(changed);
  }

  /**
   * Invalidate an object query
   *
   * @param  {String} url
   * @param  {Object|undefined} options
   *
   * @return {Boolean}
   */
  invalidateOne(url, options) {
    let changed = false;
    const absURL = this.resolveURL(url);
    const props = {
      type: 'object',
      url: absURL,
      options: options || {},
    };
    let query = this.findQuery(props);
    if (!query) {
      query = this.deriveQuery(absURL, true);
    }
    if (query && !query.expired) {
      query.expired = true;
      changed = true;
    }
    return this.notifyChanges(changed);
  }

  /**
   * Invalidate a list query
   *
   * @param  {String} url
   * @param  {Object|undefined} options
   *
   * @return {Boolean}
   */
  invalidateList(url, options) {
    let changed = false;
    const absURL = this.resolveURL(url);
    const props = {
      type: 'list',
      url: absURL,
      options: options || {},
    };
    const query = this.findQuery(props);
    if (query && !query.expired) {
      query.expired = true;
      changed = true;
    }
    return this.notifyChanges(changed);
  }

  /**
   * Invalidate a page query
   *
   * @param  {String} url
   * @param  {Number} page
   * @param  {Object|undefined} options
   *
   * @return {Boolean}
   */
  invalidatePage(url, page, options) {
    let changed = false;
    const absURL = this.resolveURL(url);
    const props = {
      type: 'page',
      url: absURL,
      page: page,
      options: options || {},
    };
    const query = this.findQuery(props);
    if (query && !query.expired) {
      query.expired = true;
      changed = true;
    }
    return this.notifyChanges(changed);
  }

  /**
   * Invalidate multiple object queries
   *
   * @param  {Array<String>} urls
   * @param  {Object|undefined} options
   *
   * @return {Boolean}
   */
  invalidateMultiple(urls, options) {
    let changed = false;
    const fetchOptions = {};
    for (let name in options) {
      if (name !== 'minimum') {
        fetchOptions[name] = options[name];
      }
    }
    for (let url of urls) {
      const absURL = this.resolveURL(url);
      const props = {
        type: 'object',
        url: absURL,
        options: fetchOptions,
      };
      const query = this.findQuery(props);
      if (query && !query.expired) {
        query.expired = true;
        changed = true;
      }
    }
    return this.notifyChanges(changed);
  }

  /**
   * Return true if a URL is cached, with optional check for expiration
   *
   * @param  {String} url
   * @param  {Boolean|undefined} unexpired
   *
   * @return {Boolean}
   */
  isCached(url, unexpired) {
    const absURL = this.resolveURL(url);
    let cached = false;
    for (let query of this.queries) {
      if (query.url === absURL) {
        if (query.object || query.objects) {
          if (!unexpired || !query.expired) {
            cached = true;
            break;
          }
        }
      }
    }
    if (!cached) {
      const folderURL = getFolderURL(absURL);
      if (folderURL) {
        const objectID = parseInt(absURL.substr(folderURL.length));
        if (objectID) {
          const query = this.deriveQuery(absURL);
          if (query) {
            cached = true;
          }
        }
      }
    }
    return cached;
  }

  /**
   * Find an existing query
   *
   * @param  {Object} props
   *
   * @return {Object|undefined}
   */
  findQuery(props) {
    return this.queries.find((query) => {
      return matchQuery(query, props);
    });
  }

  /**
   * Derive a query for an item from an existing directory query
   *
   * @param  {String} absURL
   * @param  {Boolean|undefined} add
   *
   * @return {Object|undefined}
   */
  deriveQuery(absURL, add) {
    let objectFromList;
    let retrievalTime;
    const folderAbsURL = getFolderURL(absURL);
    const objectID = parseInt(absURL.substr(folderAbsURL.length));
    for (let query of this.queries) {
      if (!query.expired) {
        if (query.type === 'page' || query.type === 'list') {
          let abbreviated = false;
          if (this.options.abbreviatedFolderContents) {
            abbreviated = true;
          } else if (query.options.abbreviated) {
            abbreviated = true;
          }
          if (!abbreviated) {
            if (omitSearchString(query.url) ===  folderAbsURL) {
              for (let object of query.objects) {
                if (object.url === absURL || object.id === objectID) {
                  objectFromList = object;
                  retrievalTime = query.time;
                  break;
                }
              }
              if (objectFromList) {
                break;
              }
            }
          }
        }
      }
    }
    if (objectFromList) {
      const query = {
        type: 'object',
        url: absURL,
        promise: Promise.resolve(objectFromList),
        object: objectFromList,
        time: retrievalTime,
        options: {}
      };
      if (add) {
        this.queries.unshift(query);
      }
      return query;
    }
  }

  /**
   * Return true when there's an authorization token
   *
   * @param  {String|undefined} url
   *
   * @return {Boolean}
   */
  isAuthorized(url) {
    const absURL = this.resolveURL(url || '/');
    const token = this.getToken(absURL);
    return !!token;
  }

  /**
   * Return a promise that will be fulfilled with the authorization token
   * when authentication suceeds or null if the request was declined
   *
   * @param  {String} absURL
   *
   * @return {Promise<String>}
   */
  requestAuthentication(absURL) {
    let promise;
    for (let authentication of this.authentications) {
      if (authentication.url === absURL) {
        promise = authentication.promise;
        break;
      }
    }
    if (!promise) {
      // add the query prior to triggering the event, since the handler
      // may call authorize()
      let resolve;
      const authentication = {
        url: absURL,
        promise: new Promise((f) => { resolve = f }),
        resolve: resolve,
      };
      this.authentications.push(authentication);

      const authenticationEvent = new DataSourceEvent('authentication', this, {
        url: absURL
      });
      this.triggerEvent(authenticationEvent);
      promise = authenticationEvent.waitForDecision().then(() => {
        const waitForAuthentication = !authenticationEvent.defaultPrevented;
        if (waitForAuthentication) {
          // wait for authenticate() to get called
          // if authorize() was called, the promise would be resolved already
          return authentication.promise;
        } else {
          // take it back out
          pullObjects(this.authentications, [ authentication ]);
          return null;
        }
      });
    }
    return promise;
  }

  /**
   * Post user credentials to given URL in expectant of a authorization token
   *
   * @param  {String} loginURL
   * @param  {Object} credentials
   * @param  {Array<String>|undefined} allowURLs
   *
   * @return {Promise<Boolean>}
   */
  authenticate(loginURL, credentials, allowURLs) {
    const loginAbsURL = this.resolveURL(loginURL);
    const allowAbsURLs = this.resolveURLs(allowURLs || [ '/' ]);
    const options = {
      method: 'POST',
      mode: 'cors',
      cache: 'no-cache',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(credentials),
    };
    return this.request(loginAbsURL, options, null, false).then((response) => {
      const token = (response) ? response.key : null;
      if (!token) {
        throw new DataSourceError(403, 'No authorization token');
      }
      return this.authorize(token, allowAbsURLs, true);
    });
  }

  /**
   * Accept an authorization token, resolving any pending authentication promises
   *
   * @param  {String} token
   * @param  {Array<String>} allowURLs
   * @param  {Boolean} fresh
   *
   * @return {Promise<Boolean>}
   */
  authorize(token, allowURLs, fresh) {
    let invalid = false;
    if (token) {
      for (let authorization of this.authorizations) {
        if (authorization.token === token) {
          if (!authorization.invalid) {
            invalid = true;
            break;
          }
        }
      }
    } else {
      invalid = true;
    }
    if (invalid) {
      return Promise.resolve(false);
    }
    const allowAbsURLs = this.resolveURLs(allowURLs || [ '/' ]);
    const authorizationEvent = new DataSourceEvent('authorization', this, {
      token: token,
      allowURLs: allowAbsURLs,
      fresh: !!fresh,
    });
    this.triggerEvent(authorizationEvent);
    return authorizationEvent.waitForDecision().then(() => {
      const acceptable = !authorizationEvent.defaultPrevented;
      if (!acceptable) {
        return false;
      }
      // remove previous authorization
      const removing = [];
      for (let authorization of this.authorizations) {
        authorization.allow = authorization.allow.filter((url) => {
          return (allowAbsURLs.indexOf(url) === -1);
        });
        if (authorization.allow.length === 0) {
          removing.push(authorization);
        }
      }
      pullObjects(this.authorizations, removing);

      // add new authorization
      const newAuthorization = {
        token: token,
        allow: allowAbsURLs,
        deny: []
      };
      this.authorizations.push(newAuthorization);

      // resolve and remove authentication querys
      const resolved = [];
      for (let authentication of this.authentications) {
        if (matchAnyURL(authentication.url, allowAbsURLs)) {
          authentication.resolve(token);
          resolved.push(authentication);
        }
      }
      pullObjects(this.authentications, resolved);
      return this.notifyChanges(true);
    });
  }

  /**
   * Cancel authentication, causing outstanding operations that require it to
   * fail (i.e. their promises will be rejected).
   *
   * @param  {Array<String>|undefined} allowURLs
   */
  cancelAuthentication(allowURLs) {
    const allowAbsURLs = this.resolveURLs(allowURLs || [ '/' ]);
    const canceled = [];
    for (let authentication of this.authentications) {
      if (matchAnyURL(authentication.url, allowAbsURLs)) {
        authentication.resolve(null);
        canceled.push(authentication);
      }
    }
    pullObjects(this.authentications, canceled);
  }

  /**
   * Remove authorization for certain URLs or all URLs.
   *
   * @param  {Array<String>|undefined} denyURLs
   */
  cancelAuthorization(denyURLs) {
    const denyAbsURLs = this.resolveURLs(denyURLs || [ '/' ]);
    const canceled = [];
    for (let authorization of this.authorizations) {
      if (!authorization.invalid) {
        authorization.allow = authorization.allow.filter((url) => {
          return (denyURLs.indexOf(url) === -1);
        });

        // add to deny list if it's still allowed
        for (let url of denyAbsURLs) {
          if (matchAnyURL(url, authorization.allow)) {
            authorization.deny.push(url);
          }
        }
        if (authorization.allow.length === 0) {
          canceled.push(authorization);
        }
      }
    }
    pullObjects(this.authorizations, canceled);
  }

  /**
   * Log out from the remote server
   *
   * @param  {String} logoutURL
   * @param  {Array<String>|undefined} denyURLs
   *
   * @return {Promise}
   */
  revokeAuthorization(logoutURL, denyURLs) {
    const logoutAbsURL = this.resolveURL(logoutURL);
    const denyAbsURLs = this.resolveURLs(denyURLs || [ '/' ]);
    const token = this.getToken(denyAbsURLs[0]);
    const options = {
      method: 'POST',
      mode: 'cors',
      cache: 'no-cache',
    };
    return this.request(logoutAbsURL, options, token, false).then(() => {
      this.cancelAuthorization(denyAbsURLs);
      const deauthorizationEvent = new DataSourceEvent('deauthorization', this, {
        denyURLs: denyAbsURLs,
      });
      this.triggerEvent(deauthorizationEvent);
      return deauthorizationEvent.waitForDecision().then(() => {
        const clearCachedQueries = !deauthorizationEvent.defaultPrevented;
        if (clearCachedQueries) {
          const denying = [];
          for (let query of this.queries) {
            if (matchAnyURL(query.url, denyAbsURLs)) {
              denying.push(query);
            }
          }
          pullObjects(this.queries, denying);
        }
        this.notifyChanges(true);
      });
    });
  }

  /**
   * Return an authorization token for the given URL
   *
   * @param  {String} url
   *
   * @return {String|undefined}
   */
  getToken(url) {
    for (let authorization of this.authorizations) {
      if (!authorization.invalid) {
        if (matchAnyURL(url, authorization.allow)) {
          if (!matchAnyURL(url, authorization.deny)) {
            return authorization.token;
          }
        }
      }
    }
  }

  /**
   * Mark authorization token as invalid
   *
   * @param  {String} token
   */
  invalidateToken(token) {
    if (token) {
      for (let authorization of this.authorizations) {
        if (authorization.token === token) {
          authorization.invalid = true;
        }
      }
    }
  }

  waitForResults(inputs) {
    const results = [];
    const errors = [];
    const promises = [];
    let error = null;
    for (let [ index, input ] of inputs.entries()) {
      if (input.then instanceof Function) {
        const promise = input.then((result) => {
          results[index] = result;
          errors[index] = null;
        }, (err) => {
          results[index] = null;
          errors[index] = err;
          if (!error) {
            error = err;
          }
        });
        promises.push(promise);
      } else {
        results[index] = input;
        errors[index] = null;
      }
    }
    this.stopExpirationCheck();
    return Promise.all(promises).then(() => {
      this.startExpirationCheck();
      if (error) {
        error.results = results;
        error.errors = errors;
      }
      return { results, errors, error };
    });
  }

  /**
   * Start expiration checking
   */
  startExpirationCheck() {
    const { refreshInterval } = this.options;
    if (refreshInterval > 0) {
      if (!this.expirationCheckInterval) {
        this.expirationCheckInterval = setInterval(() => {
          this.checkExpiration();
        }, Math.min(100, refreshInterval / 10));
      }
    }
  }

  /**
   * Stop expiration checking
   */
  stopExpirationCheck() {
    if (this.expirationCheckInterval) {
      clearInterval(this.expirationCheckInterval);
      this.expirationCheckInterval = 0;
    }
  }

  /**
   * Mark queries as expired and trigger onChange event when enough time has passed
   */
  checkExpiration() {
    const interval = Number(this.options.refreshInterval);
    if (interval) {
      const time = getTime(-interval);
      this.invalidate(time);
    }
  }

  /**
   * Perform an HTTP GET operation
   *
   * @param  {String} url
   *
   * @return {Promise<Object>}
   */
  get(url) {
    const token = this.getToken(url);
    const options = {
      method: 'GET',
    };
    return this.request(url, options, token, true);
  }

  /**
   * Perform an HTTP POST operation
   *
   * @param  {String} url
   * @param  {Object} object
   *
   * @return {Promise<Object>}
   */
  post(url, object) {
    const token = this.getToken(url);
    const options = {
      method: 'POST',
      mode: 'cors',
      cache: 'no-cache',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(object),
    };
    return this.request(url, options, token, true);
  }

  /**
   * Perform an HTTP PUT operation
   *
   * @param  {String} url
   * @param  {Object} object
   *
   * @return {Promise<Object>}
   */
  put(url, object) {
    const token = this.getToken(url);
    const options = {
      method: 'PUT',
      mode: 'cors',
      cache: 'no-cache',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(object),
    };
    return this.request(url, options, token, true);
  }

  /**
   * Perform an HTTP DELETE operation
   *
   * @param  {String} url
   *
   * @return {Promise<null>}
   */
  delete(url) {
    const token = this.getToken(url);
    const options = {
      method: 'DELETE',
      mode: 'cors',
      cache: 'no-cache',
    };
    return this.request(url, options, token, true);
  }

  /**
   * Perform an HTTP request
   *
   * @param  {String} url
   * @param  {Object} options
   * @param  {String|null} token
   * @param  {Boolean} waitForAuthentication
   *
   * @return {Promise}
   */
  request(url, options, token, waitForAuthentication) {
    if (token) {
      const { authorizationKeyword } = this.options;
      if (!options) {
        options = {};
      }
      if (!options.headers) {
        options.headers = {};
      }
      options.headers['Authorization'] = authorizationKeyword + ' ' + token;
    }
    return this.fetch(url, options).then((response) => {
      const { status, statusText } = response;
      if (status < 400) {
        if (status == 204) {
          return null;
        }
        return response.json();
      } else {
        if (status === 401 || status === 403) {
          this.invalidateToken(token);
        }
        if (status === 401 && waitForAuthentication) {
          return this.requestAuthentication(url).then((newToken) => {
            if (newToken) {
              return this.request(url, options, newToken, true);
            } else {
              throw new DataSourceError(status, statusText);
            }
          });
        } else {
          throw new DataSourceError(status, statusText);
        }
      }
    });
  }

  /**
   * Wait for active to become true then run fetch()
   *
   * @type {Promise<Response>}
   */
  fetch(url, options) {
    return this.waitForActivation().then(() => {
      let { fetchFunc } = this.options;
      if (!fetchFunc) {
        fetchFunc = fetch;
      }
      return fetchFunc(url, options).catch((err) => {
        // try again if the data source was deactivated in the middle of
        // an operation
        if (!this.active) {
          return this.fetch(url, options);
        } else {
          throw err;
        }
      });
    });
  }

  /**
   * If this.active is false, wait for it to become true
   *
   * @return {Promise}
   */
  waitForActivation() {
    if (this.active) {
      return Promise.resolve();
    }
    if (!this.activationPromise) {
      let resolve, reject;
      this.activationPromise = new Promise((f1, f2) => {
        resolve = f1;
        reject = f2;
      });
      this.activationPromise.resolve = resolve;
      this.activationPromise.reject = reject;

      if (process.env.NODE_ENV !== 'production') {
        console.log('Waiting for activate() to be called...');
      }
    }
    return this.activationPromise;
  }
}

/**
 * Run hook function on an cached fetch query after an insert, update, or
 * delete operation. Return true when query is changed.
 *
 * @param  {Object} query
 * @param  {String} hookName
 * @param  {Array<Object>|Object} input
 * @param  {String} defaultBehavior
 *
 * @return {Boolean}
 */
function runHook(query, hookName, input, defaultBehavior) {
  let hookFunc = (query.options) ? query.options[hookName] : null;
  if (!hookFunc) {
    hookFunc = defaultBehavior;
  }
  if (typeof(hookFunc) === 'string') {
    switch (hookFunc) {
      case 'refresh':
        hookFunc = refreshQuery;
        break;
      case 'ignore':
        hookFunc = ignoreChange;
        break;
      default:
        switch (query.type + '::' + hookFunc) {
          case 'object::replace':
            hookFunc = replaceObject;
            break;
          case 'list::replace':
          case 'page::replace':
            hookFunc = replaceObjects;
            break;
          case 'list::unshift':
          case 'page::unshift':
            hookFunc = unshiftObjects;
            break;
          case 'list::push':
          case 'page::push':
            hookFunc = pushObjects;
            break;
          case 'object::remove':
            hookFunc = removeObject;
            break;
          case 'list::remove':
          case 'page::remove':
            hookFunc = removeObjects;
            break;
          default:
            if (process.env.NODE_ENV !== 'production') {
              console.warn('Unknown hook "' + hookFunc + '"');
            }
            hookFunc = refreshQuery;
        }
    }
  }
  if (query.type === 'object') {
    // refresh the query if anything is amiss
    let impact = true;
    if (query.object && input) {
      try {
        impact = hookFunc(query.object, input);
      } catch (err) {
        console.error(err);
      }
    }
    if (impact === false) {
      return false;
    }
    if (impact instanceof Object) {
      query.object = impact;
      query.promise = Promise.resolve(impact);
    } else {
      query.expired = true;
    }
    return true;
  } else if (query.type === 'page' || query.type === 'list') {
    let impact = true;
    if (query.objects && input.every(Boolean)) {
      // sort list by ID or URL
      sortObjects(input);
      try {
        impact = hookFunc(query.objects, input);
      } catch (err) {
        console.error(err);
      }
    }
    if (impact === false) {
      return false;
    }
    if (impact instanceof Array) {
      const objects = impact;
      if (query.type === 'list') {
        // update the total
        const diff = objects.length - query.objects.length;
        objects.total = query.objects.total + diff;

        if (query.type === 'list') {
          // restore more function
          objects.more = query.objects.more;
        }
      }
      query.objects = objects;
      query.promise = Promise.resolve(objects);
    } else {
      query.expired = true;
    }
    return true;
  }
}

/**
 * Return false to indicate that change should be ignored
 *
 * @return {false}
 */
function ignoreChange() {
  return false;
}

/**
 * Return true to indicate that query should be rerun
 *
 * @return {true}
 */
function refreshQuery() {
  return true;
}

/**
 * Return the new object
 *
 * @param  {Object} object
 * @param  {Object} newObject
 *
 * @return {Object|false}
 */
function replaceObject(object, newObject) {
  if (!matchObject(newObject, object)) {
    return newObject;
  }
  return false;
}

/**
 * Replace old version of objects with new ones
 *
 * @param  {Array<Object>]} objects
 * @param  {Array<Object>} newObjects
 *
 * @return {Array<Object>|false}
 */
function replaceObjects(objects, newObjects) {
  let changed = false;
  const newList = [];
  for (let object of objects) {
    const newObject = findObject(newObjects, object);
    if (newObject) {
      if (!matchObject(newObject, object)) {
        changed = true;
        newList.push(newObject);
        continue;
      }
    }
    newList.push(object);
  }
  return (changed) ? newList : false;
}

/**
 * Add new objects at beginning of list
 *
 * @param  {Array<Object>} objects
 * @param  {Array<Object>} newObjects
 *
 * @return {Array<Object>|false}
 */
function unshiftObjects(objects, newObjects) {
  const newList = objects.slice();
  for (let object of newObjects) {
    newList.unshift(object);
  }
  return newList;
}

/**
 * Add new objects at end of list
 *
 * @param  {Array<Object>} objects
 * @param  {Array<Object>} newObjects
 *
 * @return {Array<Object>|false}
 */
function pushObjects(objects, newObjects) {
  const newList = objects.slice();
  for (let object of newObjects) {
    newList.push(object);
  }
  return newList;
}

/**
 * Return true to indicate that query should be removed
 *
 * @param  {Object} object
 * @param  {Object} deletedObject
 *
 * @return {true}
 */
function removeObject(object, deletedObject) {
  return true;
}

/**
 * Remove objects from list
 *
 * @param  {Array<Object>} objects
 * @param  {Array<Object>} deletedObjects
 *
 * @return {Array<Object>|false}
 */
function removeObjects(objects, deletedObjects) {
  let changed = false;
  const newList = [];
  for (let object of objects) {
    if (findObjectIndex(deletedObjects, object) === -1) {
      newList.push(object);
    } else {
      changed = true;
    }
  }
  return (changed) ? newList : false;
}

/**
 * See if a query has the given properties
 *
 * @param  {Object} query
 * @param  {Object} props
 *
 * @return {Boolean}
 */
function matchQuery(query, props) {
  for (let name in props) {
    if (!matchObject(query[name], props[name])) {
      return false;
    }
  }
  return true;
}

/**
 * See if two objects are identical
 *
 * @param  {*} object1
 * @param  {*} object2
 *
 * @return {Boolean}
 */
function matchObject(object1, object2) {
  if (object1 !== object2) {
    if (object1 instanceof Object && object2 instanceof Object) {
      if (object1.constructor !== object2.constructor) {
        return false;
      }
      if (object1 instanceof Array) {
        if (object1.length !== object2.length) {
          return false;
        }
        for (let i = 0; i < object1.length; i++) {
          if (!matchObject(object1[i], object2[i])) {
            return false;
          }
        }
      } else if (object1 instanceof Function) {
        if (object1.toString() !== object2.toString()) {
          return false;
        }
      } else {
        for (let name in object1) {
          if (!matchObject(object1[name], object2[name])) {
            return false;
          }
        }
        for (let name in object2) {
          if (!(name in object1)) {
            return false;
          }
        }
      }
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Remove trailing slash from URL
 *
 * @param  {String} url
 *
 * @return {String}
 */
function removeTrailingSlash(url) {
  const lc = url.charAt(url.length - 1);
  if (lc === '/') {
    url = url.substr(0, url.length - 1);
  }
  return url;
}

/**
 * Add leading slash to URL
 *
 * @param  {String} url
 *
 * @return {String}
 */
function addLeadingSlash(url) {
  const fc = url.charAt(0);
  if (fc !== '/') {
    url = '/' + url;
  }
  return url;
}

function addTrailingSlash(url) {
  const qi = url.indexOf('?');
  let query;
  if (qi !== -1) {
    query = url.substr(qi);
    url = url.substr(0, qi);
  }
  const lc = url.charAt(url.length - 1);
  if (lc !== '/') {
    url += '/';
  }
  if (query) {
    url += query;
  }
  return url;
}

/**
 * Return the URL of the parent folder
 *
 * @param  {String} url
 *
 * @return {String|undefined}
 */
function getFolderURL(url) {
  let ei = url.lastIndexOf('/');
  if (ei === url.length - 1) {
    ei = url.lastIndexOf('/', ei - 1);
  }
  if (ei !== -1) {
    return url.substr(0, ei + 1);
  }
}

/**
 * Return the URL of an object
 *
 * @param  {String|null} folderURL
 * @param  {Object} object
 *
 * @return {String|undefined}
 */
function getObjectURL(folderURL, object) {
  if (!object) {
    return;
  }
  if (folderURL && object.id) {
    return removeTrailingSlash(folderURL) + '/' + object.id + '/';
  } else if (object.url) {
    return object.url;
  }
}

/**
 * Return the URL of the folder containing the URL
 *
 * @param  {String|null} folderURL
 * @param  {Object} object
 *
 * @return {String|undefined}
 */
function getObjectFolderURL(folderURL, object) {
  if (!object) {
    return;
  }
  if (folderURL) {
    return omitSearchString(folderURL);
  } else if (object.url) {
    return getFolderURL(object.url);
  }
}

/**
 * Append the variable "page" to a URL's query, unless page equals 1.
 *
 * @param  {String} url
 * @param  {Number} page
 *
 * @return {String}
 */
function attachPageNumber(url, page) {
  if (page === 1) {
    return url;
  }
  const qi = url.indexOf('?');
  const sep = (qi === -1) ? '?' : '&';
  return url + sep + 'page=' + page;
}

function omitSearchString(url) {
  const qi = url.lastIndexOf('?');
  if (qi !== -1) {
    url = url.substr(0, qi);
  }
  return url;
}

/**
 * Return true if one URL points to a subfolder of another URL
 *
 * @param  {String} url
 * @param  {String} otherURL
 *
 * @return {Boolean}
 */
function matchURL(url, otherURL) {
  url = omitSearchString(url);
  if (otherURL === url) {
    return true;
  } else if (url.substr(0, otherURL.length) === otherURL) {
    const lc = otherURL.charAt(otherURL.length - 1);
    const ec = url.charAt(otherURL.length);
    if (lc === '/' || ec === '/') {
      return true;
    }
  }
  return false;
}

/**
 * Check if the given URL match any in the list
 *
 * @param  {String} url
 * @param  {Array<String>} otherURLs
 *
 * @return {Boolean}
 */
function matchAnyURL(url, otherURLs) {
  return otherURLs.some(otherURL => matchURL(url, otherURL));
}

/**
 * Find the position of an object in an array based on id or URL. Return -1 if
 * the object is not there.
 *
 * @param  {Array<Object>} list
 * @param  {Object} object
 *
 * @return {Number}
 */
function findObjectIndex(list, object) {
  const keyA = object.id || object.url;
  for (let i = 0; i < list.length; i++) {
    const keyB = list[i].id || list[i].url;
    if (keyA === keyB) {
      return i;
    }
  }
  return -1;
}

/**
 * Find an object in a list based on id or URL
 *
 * @param  {Array<Object>} list
 * @param  {Object} object
 * @param  {Boolean|undefined} different
 *
 * @return {Object|undefined}
 */
function findObject(list, object, different) {
  if (object) {
    const index = findObjectIndex(list, object);
    if (index !== -1) {
      const objectFound = list[index];
      if (different) {
        // allow object to have fewer properties than those in the list
        for (let name in object) {
          if (!matchObject(object[name], objectFound[name])) {
            return objectFound;
          }
        }
      } else {
        return objectFound;
      }
    }
  }
}

/**
 * Find objects in a list
 *
 * @param  {Array<Object>} list
 * @param  {Array<Object>} objects
 * @param  {Boolean|undefined} different
 *
 * @return {Array<Object>|undefined}
 */
function findObjects(list, objects, different) {
  if (objects) {
    const found = [];
    for (let object of objects) {
      const objectFound = findObject(list, object, different);
      if (objectFound) {
        found.push(objectFound);
      }
    }
    if (found.length > 0) {
      return found;
    }
  }
}

function excludeObjects(list, objects) {
  const newList = list.slice();
  pullObjects(newList, objects);
  if (newList.length > 0) {
    return newList;
  }
}

/**
 * Clone an object
 *
 * @param  {*} src
 *
 * @return {*}
 */
function cloneObject(src) {
  if (src instanceof Array) {
    return src.map(obj => cloneObject(obj));
  } else if (src instanceof Object) {
    const dst = {};
    for (let name in src) {
      dst[name] = cloneObject(src[name]);
    }
    return dst;
  } else {
    return src;
  }
}

/**
 * Sort a list of objects based on ID or URL
 *
 * @param  {Array<Object>} list
 */
function sortObjects(list) {
  list.sort((a, b) => {
    const keyA = a.id || a.url;
    const keyB = b.id || b.url;
    if (keyA < keyB) {
      return -1;
    } else if (keyA > keyB) {
      return +1;
    } else {
      return 0;
    }
  });
}

/**
 * Append objects to a list, removing any duplicates first
 *
 * @param  {Array<Object>} list
 * @param  {Array<Object>} objects
 *
 * @return {Array<Object>}
 */
function appendObjects(list, objects) {
  if (!list) {
    return objects;
  } else {
    const duplicates = [];
    for (let object of objects) {
      if (findObjectIndex(list, object) !== -1) {
        duplicates.push(object);
      }
    }
    pullObjects(list, duplicates);
    return list.concat(objects);
  }
}

/**
 * Replace objects in newList that are identical to their counterpart in oldList.
 * Return objects that are not found in the old list or undefined if there are
 * no change
 *
 * @param  {Array<Object>} newList
 * @param  {Array<Object>} oldList
 *
 * @return {Array<Object>|undefined}
 */
function replaceIdentificalObjects(newList, oldList) {
  const freshObjects = [];
  let changed = false;
  for (let i = 0; i < newList.length; i++) {
    const oldIndex = findObjectIndex(oldList, newList[i]);
    if (oldIndex !== -1) {
      if (matchObject(newList[i], oldList[oldIndex])) {
        newList[i] = oldList[oldIndex];
        if (i !== oldIndex) {
          changed = true;
        }
      } else {
        freshObjects.push(newList[i]);
        changed = true;
      }
    } else {
      freshObjects.push(newList[i]);
      changed = true;
    }
  }
  if (changed) {
    return freshObjects;
  }
}

/**
 * Attach objects from an older list to a new list that's being retrieved.
 *
 * @param  {Array<Object>} newList
 * @param  {Array<Object>} oldList
 *
 * @return {Array<Object>}
 */
function joinObjectLists(newList, oldList) {
  // find point where the two list intersect
  let startIndex = 0;
  for (let i = newList.length - 1; i >= 0; i--) {
    const newObject = newList[i];
    const oldIndex = findObjectIndex(oldList, newObject);
    if (oldIndex !== -1) {
      startIndex = oldIndex + 1;
      break;
    }
  }
  // don't add objects ahead of the intersection from the old list or
  // objects that are present in the new list (due to change in order)
  const oldObjects = [];
  for (let [ index, object ] of oldList) {
    if (index >= startIndex) {
      if (findObjectIndex(newList, object) === -1) {
        oldObjects.push(object);
      }
    }
  }
  return newList.concat(oldObjects);
}

/**
 * Separate objects by folder and whether the operation succeeded
 *
 * @param  {String|null} folderURL
 * @param  {Array<Object>} objects
 * @param  {Object} outcome
 *
 * @return {Object<Array>}
 */
function segregateResults(folderURL, objects, outcome) {
  const opHash = {};
  const ops = [];
  for (let i = 0; i < objects.length; i++) {
    const object = objects[i];
    const result = outcome.results[i];
    const error = outcome.errors[i];
    const objectFolderURL = getObjectFolderURL(folderURL, object);
    let op = opHash[objectFolderURL];
    if (!op) {
      op = opHash[objectFolderURL] = {
        url: objectFolderURL,
        results: null,
        rejects: null
      };
      ops.push(op);
    };
    if (result) {
      if (!op.results) {
        op.results = [];
      }
      op.results.push(result);
    } else {
      if (error) {
        switch (error.status) {
          case 404:
          case 410:
          case 409:
            if (!op.rejects) {
              op.rejects = [];
            }
            op.rejects.push(object);
            break;
        }
      }
    }
  }
  return ops;
}

/**
 * Get parameter 'minimum' from options. If it's a percent, then calculate the
 * minimum object count based on total. If it's negative, substract the value
 * from the total.
 *
 * @param  {Object} options
 * @param  {Number} total
 * @param  {Number} def
 *
 * @return {Number}
 */
function getMinimum(options, total, def) {
  let minimum = (options) ? options.minimum : undefined;
  if (typeof(minimum) === 'string') {
    minimum = minimum.trim();
    if (minimum.charAt(minimum.length - 1) === '%') {
      const percent = parseInt(minimum);
      minimum = Math.ceil(total * (percent / 100));
    }
  }
  if (minimum < 0) {
    minimum = total + minimum;
    if (minimum < 1) {
      minimum = 1;
    }
  }
  return minimum || def;
}

/**
 * Return the current time in ISO format, adding a delta optionally
 *
 * @param  {Number|undefined} delta
 *
 * @return {String}
 */
function getTime(delta) {
  let date = new Date;
  if (delta) {
    date = new Date(date.getTime() + delta);
  }
  return date.toISOString();
}

function pullObjects(list, objects) {
  if (objects instanceof Array) {
    for (let object of objects) {
      const index = list.indexOf(object);
      if (index !== -1) {
        list.splice(index, 1);
      }
    }
  }
}

export {
  RelaksDjangoDataSource,
  RelaksDjangoDataSource as DataSource,
};
