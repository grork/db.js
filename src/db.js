﻿(function (window) {
    'use strict';
    var indexedDB = window.msIndexedDB,
        IDBDatabase = window.IDBDatabase,
        IDBTransaction = window.IDBTransaction,
        IDBKeyRange = window.IDBKeyRange,
        transactionModes = {
            readonly: 'readonly',
            readwrite: 'readwrite'
        };

    var Signal = WinJS.Class.mix(WinJS.Class.define(function () {
        var that = this;
        // This uses the "that" pattern 'c ause it's called from a constructor, and
        // I don't want to mess with anything weird to upset the promise gods.
        this._wrappedPromise = new WinJS.Promise(function (c, e, p) {
            that._complete = c;
            that._error = e;
            that._progress = p;
        }, this._handleCancelled.bind(this));
    },
        {
            _wrappedPromise: null,
            _complete: null,
            _error: null,
            _progress: null,
            _handleCancelled: function _handleCancelled(e) {
                this.dispatchEvent("cancelled", { signal: this });
            },
            promise: {
                get: function () {
                    return this._wrappedPromise;
                }
            },
            complete: function signal_complete(value) {
                this._complete(value);
            },
            error: function signal_error(errorInfo) {
                this._error(errorInfo);
            },
            progress: function signal_progress(progressInfo) {
                this._progress(progressInfo);
            },
        }), WinJS.Utilities.eventMixin);

    var hasOwn = Object.prototype.hasOwnProperty;

    if (!indexedDB) {
        throw 'IndexedDB required';
    }

    var Server = function Server_Constructor(db, name) {
        var that = this,
            closed = false;
        this.add = function Server_Add(table, records) {
            if (closed) {
                throw 'Database has been closed';
            }
            var transaction = db.transaction(table, transactionModes.readwrite);
            var store = transaction.objectStore(table);

            if (records.constructor !== Array) {
                records = [records];
            }

            var signal = new Signal();

            records.forEach(function Server_Add_RecordsForEach(record) {
                var req = store.add(record);
                req.onsuccess = function Server_Add_RecordsForEach_Success(e) {
                    var target = e.target;
                    record[target.source.keyPath] = target.result;

                    signal.progress();
                };
            });

            transaction.oncomplete = function Server_Add_Complete() {
                signal.complete(records, that);
            };

            transaction.onerror = function Server_Add_Error(e) {
                signal.error(records, e);
            };

            transaction.onabort = function Server_Add_Abort(e) {
                signal.error(records, e);
            };
            return signal.promise;
        };

        this.remove = function Server_Remove(table, key) {
            if (closed) {
                throw 'Database has been closed';
            }
            var transaction = db.transaction(table, transactionModes.readwrite);
            var store = transaction.objectStore(table);

            store.delete (key);
        };

        this.query = function Server_Query(table) {
            if (closed) {
                throw 'Database has been closed';
            }
            return new Query(table, db);
        };

        this.close = function Server_Close() {
            if (closed) {
                throw 'Database has been closed';
            }
            db.close();
            closed = true;
            delete dbCache[name];
        };

        this.get = function Server_Get(table, id) {
            var transaction = db.transaction(table),
                store = transaction.objectStore(table),
                signal = new Signal();

            var req = store.get(id);
            req.onsuccess = function Server_Get_Success(e) {
                signal.complete(e.target.result);
            };
            req.onerror = function Server_Get_Error(e) {
                signal.error(e);
            };
            return signal.promise;
        };

        this.index = function Server_Index(table, index) {
            return new IndexQuery(table, index, db);
        };

        for (var i = 0, il = db.objectStoreNames.length ; i < il ; i++) {
            (function Server_Constructor_MapStoreNames(storeName) {
                that[storeName] = {};
                for (var i in that) {
                    if (!hasOwn.call(that, i) || i === 'close') {
                        continue;
                    }
                    that[storeName][i] = (function Server_Constructor_StoreNameGetter(i) {
                        return function () {
                            var args = [storeName].concat([].slice.call(arguments, 0));
                            return that[i].apply(that, args);
                        };
                    })(i);
                }
            })(db.objectStoreNames[i]);
        }
    };

    var IndexQuery = function IndexQuery_Constructor(table, indexName, db) {
        this.only = function IndexQuery_Only(val) {
            var transaction = db.transaction(table),
                store = transaction.objectStore(table),
                index = store.index(indexName),
                singleKeyRange = IDBKeyRange.only(val),
                results = [],
                signal = new Signal();

            index.openCursor(singleKeyRange).onsuccess = function IndexQuery_Only_OpenCursor(e) {
                var cursor = e.target.result;

                if (cursor) {
                    results.push(cursor.value);
                    cursor.continue();
                }
            };

            transaction.oncomplete = function IndexQuery_Only_Complete() {
                signal.complete(results);
            };
            transaction.onerror = function IndexQuery_Only_Error(e) {
                signal.error(e);
            };
            transaction.onabort = function IndexQuery_Only_Abort(e) {
                signal.error(e);
            };
            return signal.promise;
        };
    };

    var Query = function Query_Constructor(table, db) {
        var that = this,
            filters = [];

        this.filter = function Query_Filter(field, value) {
            filters.push({
                field: field,
                value: value
            });
            return that;
        };

        this.execute = function Query_Execute() {
            var records = [],
                transaction = db.transaction(table),
                store = transaction.objectStore(table);

            var req = store.openCursor();
            var signal = new Signal();

            req.onsuccess = function Query_Execute_Success(e) {
                var value, f,
                    inc = true,
                    cursor = e.target.result;

                if (cursor) {
                    value = cursor.value;
                    for (var i = 0, il = filters.length ; i < il ; i++) {
                        f = filters[i];
                        if (typeof f.field === 'function') {
                            inc = f.field(value);
                        } else if (value[f.field] !== f.value) {
                            inc = false;
                        }
                    }

                    if (inc) {
                        records.push(value);
                    } else {
                        if (~records.indexOf(value)) {
                            records = records.slice(0, records.indexOf(value)).concat(records.indexOf(value));
                        }
                    }
                    // TODO: report progress?
                    cursor.continue();
                } else {
                    signal.complete(records);
                }
            };

            req.onerror = function Query_Execute_Error(e) {
                signal.error(e);
            };
            transaction.onabort = function Query_Execute_Abort(e) {
                signal.error(e);
            };

            return signal.promise;
        };
    };

    var createSchema = function createSchema(e, schema, db) {
        if (typeof schema === 'function') {
            schema = schema();
        }

        for (var tableName in schema) {
            var table = schema[tableName];
            if (!hasOwn.call(schema, tableName)) {
                continue;
            }

            var store = db.createObjectStore(tableName, table.key);

            for (var indexKey in table.indexes) {
                var index = table.indexes[indexKey];
                store.createIndex(indexKey, index.key || indexKey, index.options || { unique: false });
            }
        }
    };

    var dbCache = {};

    window.db = {
        open: function open(options) {
            var db = dbCache[options.server];
            var request;
            var complete;
            var signal;
            if (db) {
                complete = WinJS.Promise.as(new Server(db, options.server));
            } else {
                request = indexedDB.open(options.server, options.version);
                signal = new Signal();
                complete = signal.promise;
                request.onsuccess = function open_success(e) {
                    var server = new Server(e.target.result, options.server);
                    dbCache[options.server] = e.target.result;
                    signal.complete(server);
                };

                request.onerror = function open_error(e) {
                    signal.error(e);
                };

                request.onupgradeneeded = function open_upgrade(e) {
                    createSchema(e, options.schema, e.target.result);
                };
            }

            return complete;
        },
    };
})(window);
