function PhoneSync(params) {
	window.PhoneSync.Instance=this;
	if (!window.Connection) {
		window.Connection={
			'NONE':0
		};
	}
	PhoneSync.Instance.options={
		'dbName':'tmp',
		'dbType':params.dbType || (/http/.test(document.location.toString())?'indexeddb':'file'),
		'timeout':1000, // milliseconds
		'version':0, // version parameter to send to server as _v
		'updatesUrl':'', // URL of the API
		'failedApiCallTimeout':10000,
		'ready':function(obj) { // called when the database is initialised
		},
		'syncDownloadsTimeout':60000,
		'tables':[], // list of tables to be synced
		'nonIndexableFiles':/^$/, // regexp of files not to be indexed
		'urls':{},
		'onBeforeNetwork':function() {
		},
		'onDownload':function() { // called when a new item is downloaded
		},
		'onErrorHandler':function(e) { // catchall fail callback
			console.log(e);
		},
		'onNetwork':function() {
		},
		'onBeforeSave':function() { // called before an item is saved
		},
		'onSave':function() { // called after an item is saved
		},
		'onUpdate':function() { // called after an item is updated from server
		},
		'onUpload':function() { // called when an item is uploaded
		},
		'onDelete':function() { // called when a key is deleted
		}
	};
	$.extend(PhoneSync.Instance.options, params);
	PhoneSync.Instance.fs=false;
	PhoneSync.Instance.numberOfUploads=0;
	PhoneSync.Instance.allowDownloads=true; // don't allow downloads to happen while uploads are pending
	PhoneSync.Instance.disableFS=false;
	PhoneSync.Instance.filePutQueue=[];
	PhoneSync.Instance.fileGetQueue=[];
	PhoneSync.Instance.networkInUse=false;
	PhoneSync.Instance.loggedIn=false;
	PhoneSync.Instance.tables={};
	PhoneSync.Instance.cache={};
	PhoneSync.Instance.apiCalls=[];
	PhoneSync.Instance.tablesLastUpdateClear();
	Date.prototype.toYMD = function Date_toYMD() {
		var year, month, day;
		year = String(this.getFullYear());
		month = String(this.getMonth() + 1);
		if (1 === month.length) {
			month = "0" + month;
		}
		day = String(this.getDate());
		if (1 === day.length) {
			day = "0" + day;
		}
		return year + "-" + month + "-" + day;
	};
	if (PhoneSync.Instance.options.dbType=='file') {
		window.requestFileSystem(
			LocalFileSystem.PERSISTENT, 0,
			function(filesystem) {
				var entry=filesystem.root;
				entry.getDirectory(PhoneSync.Instance.options.dbName,
					{'create':true, 'exclusive':false},
					function(root) {
						PhoneSync.Instance.fs=root;
						PhoneSync.Instance.delaySyncDownloads();
						PhoneSync.Instance.delaySyncUploads();
						PhoneSync.Instance.get('_tables', function(ret) {
							if (null === ret) {
								return;
							}
							$.extend(PhoneSync.Instance.tables, ret.obj);
						});
						PhoneSync.Instance.get('_files', function(ret) {
							if (null === ret) {
								PhoneSync.Instance.save({
									'key':'_files',
									'files':{'_files':1}
								}, null, true);
							}
						});
						PhoneSync.Instance.options.ready(PhoneSync.Instance);
						var dirReader=root.createReader();
						dirReader.readEntries(function(entries) {
							var files=[];
							for (var i=0;i<entries.length;++i) {
								var entry=entries[i];
								if (entry.isFile) {
									files.push(entry.name);
								}
							}
						}, function(err) {
							console.log('error starting index checker');
							console.log(err);
						});
					}
				);
			},
			null
		);
	}
	else if (PhoneSync.Instance.options.dbType=='indexeddb') {
		try {
			PhoneSync.Instance.dbSetupIndexedDB();
		}
		catch (e) {
			console.log(e);
		}
	}
	else {
		PhoneSync.Instance.save({
			'key':'_files',
			'files':{'_files':1}
		}, null, true);
		setTimeout(function() {
			PhoneSync.Instance.options.ready(PhoneSync.Instance);
			$(document).trigger('online');
		}, 1);
	}
	$(document).bind('online', function() {
		PhoneSync.Instance.delaySyncDownloads();
		PhoneSync.Instance.delaySyncUploads();
	});
	setInterval(function() {
		console.log('triggering uploads/downloads just in case');
		PhoneSync.Instance.delaySyncUploads();
		PhoneSync.Instance.delaySyncDownloads();
	}, 60000);
}
PhoneSync.prototype.addToSyncUploads=function(key) {
	PhoneSync.Instance.get('_syncUploads', function(ret) {
		if (!ret || ret===undefined || ret.keys===undefined) {
			ret={
				'key':'_syncUploads',
				'keys':[]
			};
		}
		if (0 < $.inArray(key, ret.keys)) {
			return;
		}
		ret.keys.push(key);
		PhoneSync.Instance.save(ret, false, true);
	});
	PhoneSync.Instance.delaySyncUploads();
};
PhoneSync.prototype.api=function(action, params, success, fail) {
	var uid=0;
	if (window.credentials) {
		if (credentials.email && credentials.password) {
			params._userdata={
				'username':credentials.email,
				'password':credentials.password
			};
		}
		uid=credentials.user_id;
		if (credentials.session_id) {
			params.PHPSESSID=credentials.session_id;
		}
	}
	if (PhoneSync.Instance.options.urls[action]===undefined) {
		console.log('no url defined for the action', action);
		fail();
		return;
	}
	var url=PhoneSync.Instance.options.urls[action];
	if ('syncDownloads' === action) {
		var lastUpdates={};
		$.each(PhoneSync.Instance.tables, function(k, v) {
			lastUpdates[k]='0000-00-00 00:00:00' === v.lastUpdate ? 0 : v.lastUpdate;
		});
		params._lastUpdates=lastUpdates;
	}
	if (PhoneSync.Instance.options.version) {
		params._v=PhoneSync.Instance.options.version;
	}
	params._uuid=(window.device&&device.uuid)?device.uuid:'no-uid|'+uid;
	PhoneSync.Instance.uuid=params._uuid;
	function recursiveClean(obj) {
		for (var prop in obj) {
			if (obj.hasOwnProperty(prop)) {
				if (typeof obj[prop]==="object"){
					recursiveClean(obj[prop]); // clean the contents of this object
					var json=JSON.stringify(obj[prop]);
					if (json==='{}' || json==='[]') { // if the object is now empty, remove it
						delete obj[prop];
					}
				}
				else if (true === obj[prop]) {
					obj[prop]=1;
				}
				else if (false === obj[prop]) {
					obj[prop]=0;
				}
				else if (null === obj[prop]) {
					delete obj[prop];
				}
				else if (0 && '' === obj[prop]) {
					delete obj[prop];
				}
			}
		}
	}
	recursiveClean(params);
	if (!fail) {
		fail=function(ret) {
			console.log('ERROR: '+JSON.stringify(ret));
		};
	}
	PhoneSync.Instance.apiCalls.push([url, params, success, fail, action]);
	PhoneSync.Instance.apiNext();
};
PhoneSync.prototype.apiAlreadyInQueue=function(name) {
	for (var i=0;i<PhoneSync.Instance.apiCalls.length;++i) {
		if (PhoneSync.Instance.apiCalls[i][4]===name) {
			return true;
		}
	}
};
PhoneSync.prototype.apiNext=function() {
	if (navigator.connection.type===Connection.NONE) {
		return PhoneSync.Instance.delayApiNext(5000);
	}
	clearTimeout(window.PhoneSync_timerApiCall);
	if (!PhoneSync.Instance.apiCalls.length) {
		return;
	}
	if (PhoneSync.Instance.networkInUse) {
		if (PhoneSync.Instance.networkInUse>(new Date())) {
			return PhoneSync.Instance.delayApiNext(1000);
		}
		PhoneSync.Instance.networkInUse=false;
		return PhoneSync.Instance.delayApiNext(1);
	}
	PhoneSync.Instance.networkInUse=new Date();
	PhoneSync.Instance.networkInUse.setSeconds(PhoneSync.Instance.networkInUse.getSeconds()+240); // block the network for the next 240 seconds
	clearTimeout(window.PhoneSync_timersClearNetwork);
	PhoneSync.Instance.options.onBeforeNetwork();
	var call=false;
	// { login/logout are priority
	for (var i=0;i<PhoneSync.Instance.apiCalls.length;++i) {
		if (PhoneSync.Instance.apiCalls[i][4]==='login' || PhoneSync.Instance.apiCalls[i][4]==='logout') {
			call=PhoneSync.Instance.apiCalls[i];
			PhoneSync.Instance.apiCalls.splice(i, 1);
			break;
		}
	}
	// }
	if (!call) { // otherwise, uploads are priority
		for (i=0;i<PhoneSync.Instance.apiCalls.length;++i) {
			if ('syncUploads' === PhoneSync.Instance.apiCalls[i][4]) {
				call=PhoneSync.Instance.apiCalls[i];
				PhoneSync.Instance.apiCalls.splice(i, 1);
			 break;
			}
		}
	}
	if (!call) { // else, just pick the first in the list
		call=PhoneSync.Instance.apiCalls.shift();
	}
	var url=call[0], params=call[1], success=call[2], fail=call[3], action=call[4];
	PhoneSync.Instance.mostRecentApiCallType=action;
	PhoneSync.Instance.apiXHR=$.post(url, params)
		.done(function(ret) {
			PhoneSync.Instance.options.onNetwork();
			if (!ret) {
				console.log('error while sending request', url, params, ret);
				PhoneSync.Instance.options.errorHandler({'err':'error while sending request'});
			}
			else if (ret.error) {
				console.log('ERROR: '+JSON.stringify(ret), url, params, ret);
				if (PhoneSync.Instance.options.errorHandler) {
					PhoneSync.Instance.options.errorHandler(ret);
				}
			}
			else {
				if (action==='login') {
					PhoneSync.Instance.loggedIn=true;
				}
				if (success) {
					success(ret);
				}
			}
		})
		.fail(function(ret) {
			PhoneSync.Instance.apiCalls.push(call);
			fail();
		})
		.always(function() {
			PhoneSync.Instance.networkInUse=false;
			window.clearTimeout(window.PhoneSync_timersClearNetwork);
			PhoneSync.Instance.delayApiNext(1);
		});
};
PhoneSync.prototype.apiQueueClear=function(type) {
	if (type===undefined || type==='') {
		type='syncDownloads';
	}
	
	if (PhoneSync.Instance.apiXHR) {
		if (type=='all' || type==PhoneSync.Instance.mostRecentApiCallType) {
			PhoneSync.Instance.apiXHR.abort();
		}
	}
	var arr=[];
	for (var i=0;i<PhoneSync.Instance.apiCalls.length;++i) {
		if (type=='all' || type==PhoneSync.Instance.apiCalls[i][4]) {
			continue;
		}
		arr.push(PhoneSync.Instance.apiCalls[i]);
	}
	PhoneSync.Instance.apiCalls=arr;
	PhoneSync.Instance.networkInUse=false;
	PhoneSync.Instance.inSyncDownloads=false;
};
PhoneSync.prototype.dbSetupIndexedDB=function() {
	var dbreq=window.indexedDB.open(PhoneSync.Instance.options.dbName, 3);
	dbreq.onsuccess=function(ev) {
		PhoneSync.Instance.fs=ev.target.result;
		PhoneSync.Instance.delaySyncDownloads();
		PhoneSync.Instance.delaySyncUploads();
		PhoneSync.Instance.get('_tables', function(ret) {
			if (null === ret) {
				return;
			}
			$.extend(PhoneSync.Instance.tables, ret.obj);
		});
		PhoneSync.Instance.get('_files', function(ret) {
			if (null === ret) {
				PhoneSync.Instance.save({
					'key':'_files',
					'files':{'_files':1}
				}, null, true);
			}
		});
		PhoneSync.Instance.options.ready(PhoneSync.Instance);
	};
	dbreq.onupgradeneeded=function(e) {
		console.log('upgrading');
		PhoneSync.Instance.fs=e.target.result;
		if (!PhoneSync.Instance.fs.objectStoreNames.contains(PhoneSync.Instance.options.dbName)) {
			PhoneSync.Instance.fs.createObjectStore(PhoneSync.Instance.options.dbName);
		}
	};
};
PhoneSync.prototype.delayAllowDownloads=function() {
	PhoneSync.Instance.allowDownloads=false;
	window.clearTimeout(window.PhoneSync_timerAllowDownloads);
	window.PhoneSync_timerAllowDownloads=window.setTimeout(function() {
		PhoneSync.Instance.get('_syncUploads', function(obj) {
			if (!obj || obj===undefined || obj.keys===undefined || obj.keys.length===0) { // nothing to upload
				PhoneSync.Instance.allowDownloads=true;
			}
			else {
				PhoneSync.Instance.delayAllowDownloads();
			}
		});
	}, PhoneSync.Instance.options.timeout);
};
PhoneSync.prototype.delayApiNext=function(delay) {
	
	window.clearTimeout(window.PhoneSync_timerApiCall);
	window.PhoneSync_timerApiCall=window.setTimeout(function() {
		PhoneSync.Instance.apiNext();
	}, delay||1000);
};
PhoneSync.prototype.delayFilePutJSON=function(delay) {
	window.clearTimeout(window.PhoneSync_timerFilePutQueue);
	window.PhoneSync_timerFilePutQueue=window.setTimeout(function() {
		PhoneSync.Instance.filePutJSON();
	}, delay||PhoneSync.Instance.options.timeout);
};
PhoneSync.prototype.delayIdxPutJSON=function(delay) {
	window.clearTimeout(window.PhoneSync_timerIdxPutQueue);
	window.PhoneSync_timerIdxPutQueue=window.setTimeout(function() {
		PhoneSync.Instance.idxPutJSON();
	}, delay||PhoneSync.Instance.options.timeout);
};
PhoneSync.prototype.delaySyncDownloads=function(delay) {
	
	delay=delay||PhoneSync.Instance.options.timeout;
	clearTimeout(window.PhoneSync_timerSyncDownloads);
	window.PhoneSync_timerSyncDownloads=setTimeout(function() {
		PhoneSync.Instance.syncDownloads();
	}, delay);
};
PhoneSync.prototype.delaySyncUploads=function(delay) {
	
	window.clearTimeout(window.PhoneSync_timerSyncUploads);
	window.PhoneSync_timerSyncUploads=setTimeout(function() {
		PhoneSync.Instance.syncUploads();
	}, delay||PhoneSync.Instance.options.timeout);
};
PhoneSync.prototype.delete=function(key, callback) {
	
	if (PhoneSync.Instance.disableFS) {
		return;
	}
	delete PhoneSync.Instance.cache[key];
	if (/-/.test(key)) {
		PhoneSync.Instance.idDel(key.replace(/-[^-]*$/, ''), key.replace(/.*-/, ''));
	}
	if (callback) {
		callback();
	}
	if ('indexeddb' === PhoneSync.Instance.options.dbType) {
		var txn=PhoneSync.Instance.fs.transaction([PhoneSync.Instance.options.dbName], 'readwrite');
		if (txn) {
			var store=txn.objectStore(PhoneSync.Instance.options.dbName);
			store.delete(key);
			store.onsuccess=function(ev) {
				PhoneSync.Instance.get('_files', function(ret) {
					if (ret===null) {
						return;
					}
					if (ret.files[key]) {
						delete ret.files[key];
						PhoneSync.Instance.save(ret, null, true);
					}
				});
			};
		}
		else {
			console.log('could not open indexeddb transaction');
		}
	}
	else if ('files' === PhoneSync.Instance.options.dbType) {
		PhoneSync.Instance.fs.getFile(key, {create: false, exclusive: false}, function(file) {
			file.remove();
			PhoneSync.Instance.get('_files', function(ret) {
				if (ret===null) {
					return;
				}
				if (ret.files[key]) {
					delete ret.files[key];
					PhoneSync.Instance.save(ret, null, true);
				}
			});
		});
	}
	else {
		PhoneSync.Instance.get('_files', function(ret) {
			if (ret===null) {
				return;
			}
			if (ret.files[key]) {
				delete ret.files[key];
				PhoneSync.Instance.save(ret);
			}
		});
	}
	PhoneSync.Instance.options.onDelete(key);
};
PhoneSync.prototype.fileGetJSON=function(name, success, fail) {
	
	if (PhoneSync.Instance.disableFS) {
		return;
	}
	if (!PhoneSync.Instance.fs) {
		return window.setTimeout(function() {
			PhoneSync.Instance.fileGetJSON(name, success, fail);
		}, PhoneSync.Instance.options.timeout);
	}
	PhoneSync.Instance.fs.getFile(PhoneSync.Instance.sanitise(name), {'create':false, 'exclusive':false},
		function(entry) {
			entry.file(
				function(file) {
					var reader=new FileReader();
					reader.onloadend=function(evt) {
						if (evt.target.result) {
							success(JSON.parse(
								evt.target.result
									.replace(/,\\*"[^"]*":\[\]/, '')
									.replace(/\\*"[^"]*":\[\],/, '')
									.replace(/[\u2018\u2019]/g, "'")
									.replace(/[\u201C\u201D]/g, '\\"')
							));
						}
						else {
							fail();
						}
					};
					reader.readAsText(file);
				},
				fail
			);
		},
		fail
	);
};
PhoneSync.prototype.filePutJSON=function(name, obj) {
	var f;
	if (PhoneSync.Instance.disableFS || 'none'===PhoneSync.Instance.options.dbType) {
		return PhoneSync.Instance.options.onSave?PhoneSync.Instance.options.onSave(name, obj):0;
	}
	// { if a file is submitted, queue it and come back later
	if (name && obj) {
		for (var i=1;i<PhoneSync.Instance.filePutQueue.length;++i) { // if the file is already in the queue, remove the old copy as it is out of date
			f=PhoneSync.Instance.filePutQueue[i];
			if (f[0]===name) {
				PhoneSync.Instance.filePutQueue.splice(i, 1);
			 break;
			}
		}
		PhoneSync.Instance.filePutQueue.push([name, obj]);
		return PhoneSync.Instance.delayFilePutJSON(1);
	}
	// }
	// { if a file is currently being written, then come back later
	if (PhoneSync.Instance.filePutJSONLock) {
		return PhoneSync.Instance.delayFilePutJSON(1);
	}
	// }
	// { write a file
	PhoneSync.Instance.filePutJSONLock=true;
	PhoneSync.Instance.currentFilePutFile=PhoneSync.Instance.filePutQueue.shift();
	if (PhoneSync.Instance.currentFilePutFile) {
		name=PhoneSync.Instance.currentFilePutFile[0];
		obj=PhoneSync.Instance.currentFilePutFile[1];
		var json=JSON.stringify(obj);
		PhoneSync.Instance.fs.getFile(PhoneSync.Instance.sanitise(name), {'create':true, 'exclusive':false},
			function(entry) {
				entry.createWriter(
					function(writer) {
						writer.onwriteend=function() {
							delete PhoneSync.Instance.cache[name];
							if (PhoneSync.Instance.options.onSave) {
								PhoneSync.Instance.options.onSave(name, obj);
							}
							if (name!=='_files') {
								PhoneSync.Instance.get('_files', function(ret) {
									if (ret===null) {
										ret={
											'key':'_files',
											'files':{'_files':1}
										};
									}
									if (ret.files[name]===undefined) {
										ret.files[name]=1;
										PhoneSync.Instance.save(ret, null, true);
									}
								});
							}
							PhoneSync.Instance.filePutJSONLock=false;
							if (PhoneSync.Instance.filePutQueue.length) {
								PhoneSync.Instance.delayFilePutJSON(1);
							}
						};
						writer.write(json);
					},
					function(err) { // failed to create writer
						console.log('ERROR', 'failed to create writer', err);
						PhoneSync.Instance.filePutQueue.unshift(PhoneSync.Instance.currentFilePutFile);
						PhoneSync.Instance.delayFilePutJSON();
					}
				);
			},
			function(err) {
				console.error(err);
			}
		);
	}
	else {
		if (PhoneSync.Instance.filePutQueue.length) {
			PhoneSync.Instance.delayFilePutJSON(1);
		}
	}
	// }
};
PhoneSync.prototype.get=function(key, callback, download, failcallback) {
	if (!callback) {
		callback=function() {};
	}
	function doTheGet(rekeys) {
		function delayGet(key, callback, download) {
			return setTimeout(function() {
				PhoneSync.Instance.get(key, callback, download);
			}, 1);
		}
		function fail2() {
			if (download) {
				if (PhoneSync.Instance.inSyncDownloads) {
					PhoneSync.Instance.inSyncDownloads=false;
					PhoneSync.Instance.networkInUse=false;
					PhoneSync.Instance.apiXHR.abort();
				}
				PhoneSync.Instance.api('syncDownloadOne', {
					'key':key
				}, function(ret) {
					var obj={
						'key':key,
						'obj':ret
					};
					PhoneSync.Instance.save(obj);
					callback(obj);
				}, fail, function() {
					console.log('offline - cannot download missing resource: '+key);
				});
			}
			else {
				fail();
			}
		}
		if (!(undefined===rekeys || null === rekeys) && rekeys.changes && rekeys.changes[key]) {
			key=rekeys.changes[key];
		}
		if (PhoneSync.Instance.cache._files) {
			if (PhoneSync.Instance.cache._files.files[key]===undefined && (undefined===download || !download)) {
				if ('_rekeys' === key) {
					rekeys={
						'key':'_rekeys',
						'changes':{}
					};
					lch.save(rekeys, null, true);
					callback(rekeys);
					return rekeys;
				}
				return fail();
			}
		}
		for (var i=0;i<PhoneSync.Instance.fileGetQueue.length;++i) {
			if (PhoneSync.Instance.fileGetQueue[i]===key) {
				return delayGet(key, callback, download);
			}
		}
		PhoneSync.Instance.fileGetQueue.push(key);
		if (PhoneSync.Instance.options.dbType=='file') {
			PhoneSync.Instance.fileGetJSON(key,
				function(obj) {
					var arr=[];
					for (var i=0;i<PhoneSync.Instance.fileGetQueue.length;++i) {
						if (PhoneSync.Instance.fileGetQueue[i]!==key) {
							arr.push(PhoneSync.Instance.fileGetQueue[i]);
						}
					}
					PhoneSync.Instance.fileGetQueue=arr;
					PhoneSync.Instance.cache[key]=obj;
					callback($.extend({}, obj));
				},
				function() {
					if (download) {
						if (PhoneSync.Instance.inSyncDownloads) {
							PhoneSync.Instance.inSyncDownloads=false;
							PhoneSync.Instance.networkInUse=false;
							PhoneSync.Instance.apiXHR.abort();
						}
						PhoneSync.Instance.api('syncDownloadOne', {
							'key':key
						}, function(ret) {
							var obj={
								'key':key,
								'obj':ret
							};
							PhoneSync.Instance.save(obj);
							callback(obj);
						}, fail, function() {
							console.log('offline - cannot download missing resource: '+key);
						});
					}
					else {
						fail();
					}
				}
			);
		}
		else if (PhoneSync.Instance.options.dbType=='indexeddb') {
			PhoneSync.Instance.idxGetJSON(
				key,
				function(obj) {
					if (obj===undefined) {
						return fail2();
					}
					var arr=[];
					for (var i=0;i<PhoneSync.Instance.fileGetQueue.length;++i) {
						if (PhoneSync.Instance.fileGetQueue[i]!==key) {
							arr.push(PhoneSync.Instance.fileGetQueue[i]);
						}
					}
					PhoneSync.Instance.fileGetQueue=arr;
					PhoneSync.Instance.cache[key]=obj;
					callback($.extend({}, obj));
				},
				fail2
			);
		}
	}
	function fail() {
		if (failcallback) {
			failcallback();
		}
		var arr=[];
		for (var i=0;i<PhoneSync.Instance.fileGetQueue.length;++i) {
			if (PhoneSync.Instance.fileGetQueue[i]!==key) {
				arr.push(PhoneSync.Instance.fileGetQueue[i]);
			}
		}
		PhoneSync.Instance.fileGetQueue=arr;
		callback(null);
	}
	
	if (PhoneSync.Instance.disableFS) {
		return;
	}
	if (PhoneSync.Instance.cache[key]) {
		if (!(PhoneSync.Instance.cache[key]===null && download)) {
			return callback($.extend({}, PhoneSync.Instance.cache[key]));
		}
	}
	if ('_rekeys' === key) {
		doTheGet(null);
	}
	else {
		PhoneSync.Instance.get('_rekeys', doTheGet, false, function() {
			obj={
				'key':'_rekeys',
				'changes':{}
			};
			lch.save(obj, false, true);
		});
	}
};
PhoneSync.prototype.getAll=function(key, callback) {
	
	if (PhoneSync.Instance.disableFS) {
		return;
	}
	var keys=[];
	if (PhoneSync.Instance.cache[key]) {
		keys=PhoneSync.Instance.cache[key].obj;
	}
	else {
		PhoneSync.Instance.get(key, function(ret) {
			if (ret===undefined || ret===null) {
				return callback([]);
			}
			PhoneSync.Instance.getAll(key, callback);
		});
		return;
	}
	var rows=[];
	var toGet=keys.length;
	function getObject(ret) {
		rows.push($.extend({}, ret));
		toGet--;
		if (!toGet) {
			callback(rows);
		}
	}
	for (var i=0;i<keys.length;++i) {
		PhoneSync.Instance.get(key+'-'+keys[i], getObject);
	}
};
PhoneSync.prototype.getAllById=function(keys, callback) {
	if (PhoneSync.Instance.disableFS) {
		return;
	}
	var rows=[];
	var toGet=keys.length;
	function getObject(ret) {
		if (ret!==null) {
			rows.push($.extend({}, ret));
		}
		toGet--;
		if (!toGet) {
			callback(rows);
		}
	}
	for (var i=0;i<keys.length;++i) {
		PhoneSync.Instance.get(keys[i], getObject);
	}
};
PhoneSync.prototype.getSome=function(keys, callback) {
	var toGet=keys.length, vals=[];
	function gather(ret) {
		vals.push(ret);
		toGet--;
		if (!toGet) {
			callback(vals);
		}
	}
	for (var i=0;i<keys.length;++i) {
		lch.get(keys[i], gather);
	}
};
PhoneSync.prototype.idAdd=function(name, id, callback) {
	
	id=''+id;
	PhoneSync.Instance.get(name, function(ret) {
		if (!ret || !ret.obj) {
			ret={'obj':[]};
		}
		if ($.inArray(id, ret.obj)===-1) {
			ret.obj.push(id);
			PhoneSync.Instance.save({
				'key':name,
				'obj':ret.obj,
				'id':id // added to let recursive idAdd work
			}, callback , true);
		}
		else {
			if (callback) {
				setZeroTimeout(callback);
			}
		}
	});
};
PhoneSync.prototype.idDel=function(name, id) {
	
	id=''+id;
	PhoneSync.Instance.get(name, function(ret) {
		ret=ret||{'obj':[]};
		var arr=[];
		if (ret.obj) {
			for (var i=0;i<ret.obj.length;++i) {
				if (id !== ret.obj[i]) {
					arr.push(ret.obj[i]);
				}
			}
		}
		PhoneSync.Instance.save({
			'key':name,
			'obj':arr,
			'id':id // added to let recursive idAdd work
		}, false, true);
	});
};
PhoneSync.prototype.idxPutJSON=function(name, obj) {
	
	if (PhoneSync.Instance.disableFS || 'none'===PhoneSync.Instance.options.dbType) {
		return PhoneSync.Instance.options.onSave?PhoneSync.Instance.options.onSave(name, obj):0;
	}
	// { if a file is submitted, queue it and come back later
	if (name && obj) {
		for (var i=1;i<PhoneSync.Instance.filePutQueue.length;++i) { // if the file is already in the queue, remove the old copy as it is out of date
			var f=PhoneSync.Instance.filePutQueue[i];
			if (f[0]===name) {
				PhoneSync.Instance.filePutQueue.splice(i, 1);
			 break;
			}
		}
		PhoneSync.Instance.filePutQueue.push([name, obj]);
		return PhoneSync.Instance.delayIdxPutJSON(1);
	}
	// }
	// { if a file is currently being written, then come back later
	if (PhoneSync.Instance.idxPutJSONLock) {
		return PhoneSync.Instance.delayIdxPutJSON(1);
	}
	// }
	// { write a file
	PhoneSync.Instance.idxPutJSONLock=true;
	var o=PhoneSync.Instance.filePutQueue.shift();
	if (o) {
		name=o[0];
		obj=o[1];
		var txn=PhoneSync.Instance.fs.transaction([PhoneSync.Instance.options.dbName], 'readwrite');
		var store=txn.objectStore(PhoneSync.Instance.options.dbName);
		txn.onerror=function(e) {
			console.log('ERROR', 'failed to create file', e);
			PhoneSync.Instance.filePutQueue.unshift(o);
			PhoneSync.Instance.delayIdxPutJSON();
		};
		txn.oncomplete=function() {
			if (PhoneSync.Instance.options.onSave) {
				PhoneSync.Instance.options.onSave(name, obj);
			}
			if (name!=='_files') {
				PhoneSync.Instance.get('_files', function(ret) {
					if (ret===null || ret.files===undefined) {
						ret={
							'key':'_files',
							'files':{'_files':1}
						};
					}
					if (ret.files[name]===undefined) {
						ret.files[name]=1;
						setZeroTimeout(function() {
							PhoneSync.Instance.save(ret, null, true);
						});
					}
				});
			}
			PhoneSync.Instance.idxPutJSONLock=false;
			if (PhoneSync.Instance.filePutQueue.length) {
				PhoneSync.Instance.delayIdxPutJSON(1);
			}
		};
		store.put(obj, name);
	}
	else {
		if (PhoneSync.Instance.filePutQueue.length) {
			PhoneSync.Instance.delayIdxPutJSON(1);
		}
	}
	// }
};
PhoneSync.prototype.idxGetJSON=function(name, success, fail) {
	
	if (PhoneSync.Instance.disableFS) {
		return;
	}
	if (!PhoneSync.Instance.fs) {
		return window.setTimeout(function() {
			PhoneSync.Instance.idxGetJSON(name, success, fail);
		}, PhoneSync.Instance.options.timeout);
	}
	var txn=PhoneSync.Instance.fs.transaction([PhoneSync.Instance.options.dbName]);
	if (txn) {
		var store=txn.objectStore(PhoneSync.Instance.options.dbName);
		var ob=store.get(name);
		ob.onsuccess=function(ev) {
			if (ob.result===undefined) {
				ob.result=null;
			}
			success(ob.result);
		};
		ob.fail=function() {
			fail();
		};
	}
	else {
		console.log('could not open indexeddb transaction');
	}
};
PhoneSync.prototype.nuke=function(callback) {
	if (PhoneSync.Instance.options.dbType=='file') {
		PhoneSync.Instance.disableFS=true;
		try {
			PhoneSync.Instance.fs.removeRecursively(function() {
				console.log('successfully nuked. rebuilding now.');
				window.requestFileSystem(
					LocalFileSystem.PERSISTENT, 0,
					function(filesystem) {
						var entry=filesystem.root;
						function createRoot() {
							entry.getDirectory(
								PhoneSync.Instance.options.dbName,
								{'create':true, 'exclusive':false},
								function(root) {
									PhoneSync.Instance.fs=root;
									PhoneSync.Instance.disableFS=false;
									PhoneSync.Instance.delaySyncDownloads();
									PhoneSync.Instance.delaySyncUploads();
									PhoneSync.Instance.options.ready(PhoneSync.Instance);
									for (var i in PhoneSync.Instance.tables) {
										PhoneSync.Instance.tables[i].lastUpdate='0000-00-00 00:00:00';
									}
									PhoneSync.Instance.save( { 'key':'_tables', 'obj':PhoneSync.Instance.tables }, false, true);
									callback();
								},
								function(e) {
									console.log(e);
									setTimeout(createRoot, PhoneSync.Instance.options.timeout);
								}
							);
						}
						createRoot();
					},
					function(e) {
						console.log(e);
					}
				);
			});
		}
		catch (e) {
			console.log(e);
		}
	}
	else if (PhoneSync.Instance.options.dbType=='indexeddb') {
		PhoneSync.Instance.disableFS=true;
		console.log('okay - about to request the deletion');
		var req=indexedDB.deleteDatabase(PhoneSync.Instance.options.dbName);
		req.onerror=function() {
			console.log('failed to nuke');
		};
		if (callback) {
			callback();
		}
	}
	else {
		if (callback) {
			callback();
		}
	}
	PhoneSync.Instance.tablesLastUpdateClear();
	PhoneSync.Instance.alreadyDoingSyncUpload=0;
	PhoneSync.Instance.cache={};
};
PhoneSync.prototype.rekey=function(table, oldId, newId, callback) {
	if (oldId==newId) {
		return;
	}
	PhoneSync.Instance.get('_rekeys', function(obj) {
		if (null === obj) {
			obj={
				'key':'_rekeys',
				'changes':{}
			};
		}
		obj.changes[table+'-'+oldId]=table+'-'+newId;
		lch.save(obj, null, true);
	});
	PhoneSync.Instance.get(table+'-'+oldId, function(obj) {
		obj.key=table+'-'+newId;
		obj.obj.id=newId;
		PhoneSync.Instance.save(obj, callback, true);
		PhoneSync.Instance.delete(table+'-'+oldId);
	});
};
PhoneSync.prototype.sanitise=function(name) {
	return name.replace(/[^a-zA-Z0-9\-]/g, '');
};
PhoneSync.prototype.save=function(obj, callback, nosync) {
	PhoneSync.Instance.options.onBeforeSave(obj.key, obj);
	if (PhoneSync.Instance.disableFS) {
		return;
	}
	PhoneSync.Instance.cache[obj.key]=obj;
	var id=obj.obj && obj.obj.id ? obj.obj.id : obj.id;
	if (/-/.test(obj.key) && id) {
		PhoneSync.Instance.idAdd(obj.key.replace(/-[^-]*$/, ''), id, function() {
			if (callback) {
				setZeroTimeout(callback);
			}
			if (!(nosync || /^_/.test(obj.key))) {
				PhoneSync.Instance.addToSyncUploads(obj.key);
			}
			if (PhoneSync.Instance.options.dbType=='file') {
				PhoneSync.Instance.filePutJSON(obj.key, obj);
			}
			else if (PhoneSync.Instance.options.dbType=='indexeddb') {
				PhoneSync.Instance.idxPutJSON(obj.key, obj);
			}
		});
	}
	else {
		if (callback) {
			setZeroTimeout(callback);
		}
		if (!nosync) {
			PhoneSync.Instance.addToSyncUploads(obj.key);
		}
		if (PhoneSync.Instance.options.dbType=='file') {
			PhoneSync.Instance.filePutJSON(obj.key, obj);
		}
		else if (PhoneSync.Instance.options.dbType=='indexeddb') {
			PhoneSync.Instance.idxPutJSON(obj.key, obj);
		}
	}
};
PhoneSync.prototype.syncDownloads=function() {
	
	if (!PhoneSync.Instance.allowDownloads || !window.credentials || PhoneSync.Instance.inSyncDownloads) {
		return PhoneSync.Instance.delaySyncDownloads();
	}
	if (PhoneSync.Instance.apiAlreadyInQueue('syncDownloads')) {
		return;
	}
	if (PhoneSync.Instance.disableFS) {
		console.log('fs disabled');
		return;
	}
	if (!PhoneSync.Instance.loggedIn) {
		return PhoneSync.Instance.delaySyncDownloads(15000);
	}
	PhoneSync.Instance.inSyncDownloads=true;
	clearTimeout(window.PhoneSync_timerSyncDownloads);
	PhoneSync.Instance.api(
		'syncDownloads', {},
		function(ret) {
			// { relink headers and values if headers and values are separate
			$.each(ret, function(k, v) {
				var headers=v[0], vals=[];
				if (!$.isArray(headers)) {
					return;
				}
				for (var i=0;i<v[1].length;++i) {
					var obj={};
					for (var j=0;j<headers.length;++j) {
						obj[headers[j]]=v[1][i][j];
					}
					vals.push(obj);
				}
				ret[k]=vals;
			});
			// }
			var changes=0;
			// handle deletes first
			$.each(ret, function(k, v) {
				if (k!=='_deletes') {
					return;
				}
				if (!$.isArray(v)) {
					return;
				}
				var deletes=v, tableUpdatesChanged=false, i=0;
				for (;i<v.length;++i) {
					var obj=v[i];
					if (!PhoneSync.Instance.tables[k].lastUpdate || obj.last_edited>PhoneSync.Instance.tables[k].lastUpdate) {
						PhoneSync.Instance.tables[k].lastUpdate=obj.last_edited;
						tableUpdatesChanged=true;
						changes++;
					}
				}
				if (tableUpdatesChanged) {
					PhoneSync.Instance.save( { 'key':'_tables', 'obj':PhoneSync.Instance.tables }, false, true);
				}
				for (i=0;i<deletes.length;++i) {
					if (deletes[i].key===undefined) {
						deletes[i].key=deletes[i].table_name+'-'+deletes[i].item_id;
					}
					PhoneSync.Instance.delete(deletes[i].key);
					changes++;
				}
			});
			// then do the rest
			var tablesToDo=0;
			$.each(ret, function(k, v) {
				tablesToDo++;
				if (!$.isArray(v) || k=='_deletes') {
					tablesToDo--;
					return;
				}
				var tableUpdatesChanged=false;
				var i=0;
				function next() {
					if (i==v.length) {
						if (tableUpdatesChanged) {
							PhoneSync.Instance.save( { 'key':'_tables', 'obj':PhoneSync.Instance.tables }, false, true);
						}
						tablesToDo--;
						if (!tablesToDo) {
							PhoneSync.Instance.inSyncDownloads=false;
							PhoneSync.Instance.delaySyncDownloads(changes?100:PhoneSync.Instance.options.syncDownloadsTimeout);
						}
						return;
					}
					var obj=v[i];
					i++;
					if (obj===null) {
						return setZeroTimeout(next);
					}
					if (!PhoneSync.Instance.tables[k].lastUpdate || obj.last_edited>PhoneSync.Instance.tables[k].lastUpdate) {
						PhoneSync.Instance.tables[k].lastUpdate=obj.last_edited;
						tableUpdatesChanged=true;
						changes++;
					}
					(function(k, obj) {
						PhoneSync.Instance.get(k+'-'+obj.id, function(ret) {
							if (ret===null) {
								PhoneSync.Instance.options.onDownload(k+'-'+obj.id, obj);
							}
							if (PhoneSync.Instance.uuid==obj.uuid) { // originally came from device
								if (ret===null) {
									PhoneSync.Instance.save({
										'key':k+'-'+obj.id,
										'obj':obj
									}, next, true);
									PhoneSync.Instance.options.onUpdate(k+'-'+obj.id, obj);
								}
								else setZeroTimeout(next);
							}
							else { // created somewhere else
								PhoneSync.Instance.save({
									'key':k+'-'+obj.id,
									'obj':obj
								}, next, true);
								PhoneSync.Instance.options.onUpdate(k+'-'+obj.id, obj);
							}
						});
					})(k, obj);
				}
				next();
			});
			if (!tablesToDo) {
				PhoneSync.Instance.inSyncDownloads=false;
				PhoneSync.Instance.delaySyncDownloads(changes?100:PhoneSync.Instance.options.syncDownloadsTimeout);
			}
		},
		function(err) {
			PhoneSync.Instance.inSyncDownloads=false;
			PhoneSync.Instance.delaySyncDownloads(PhoneSync.Instance.options.syncDownloadsTimeout);
		}
	);
};
PhoneSync.prototype.syncUploads=function() {
	if (!PhoneSync.Instance.loggedIn || !window.credentials) {
		return PhoneSync.Instance.delaySyncUploads(5000);
	}
	if (PhoneSync.Instance.apiAlreadyInQueue('syncUploads')) {
		return;
	}
	if (PhoneSync.Instance.alreadyDoingSyncUpload) {
		return PhoneSync.Instance.delaySyncUploads(1);
	}
	if (PhoneSync.Instance.inSyncDownloads) {
		PhoneSync.Instance.apiQueueClear('syncDownloads');
	}
	var numberOfUploads=++PhoneSync.Instance.numberOfUploads;
	if (PhoneSync.Instance.disableFS) {
		return;
	}
	PhoneSync.Instance.get('_syncUploads', function(obj) {
		if (!obj || obj===undefined || obj.keys===undefined || obj.keys.length===0) { // nothing to upload
			PhoneSync.Instance.delaySyncDownloads();
			return;
		}
		var key=obj.keys[0];
		PhoneSync.Instance.delayAllowDownloads();
		console.log('about to upload');
		if (/^_/.test(key)) { // items beginning with _ should not be uploaded
			obj.keys.shift();
			return PhoneSync.Instance.save(obj, function() {
				console.log('syncUploads contained an invalid key, '+key+'. removed.');
				PhoneSync.Instance.delaySyncUploads(1);
			}, true);
		}
		if (PhoneSync.Instance.alreadyDoingSyncUpload) {
			return PhoneSync.Instance.delaySyncUploads(1);
		}
		PhoneSync.Instance.alreadyDoingSyncUpload=1;
		PhoneSync.Instance.get(key, function(ret) {
			if (ret===null) { // item does not exist. remove from queue
				console.log('object with key '+key+' does not exist');
				obj.keys.shift();
				return PhoneSync.Instance.save(obj, function() {
					PhoneSync.Instance.alreadyDoingSyncUpload=0;
					PhoneSync.Instance.delaySyncUploads(1);
				}, true);
			}
			if (PhoneSync.Instance.inSyncDownloads) {
				PhoneSync.Instance.inSyncDownloads=false;
				PhoneSync.Instance.networkInUse=false;
				PhoneSync.Instance.apiXHR.abort();
			}
			window.syncUploadsClearTimeout=setTimeout(function() {
				PhoneSync.Instance.alreadyDoingSyncUpload=0;
			}, 60000);
			PhoneSync.Instance.api(
				'syncUploads', {
					'key':ret.key,
					'obj':JSON.stringify(ret.obj)
				},
				function(ret) { //  success
					clearTimeout(window.syncUploadsClearTimeout);
					if (obj.keys[0]!==key) {
						console.warn('DUPLICATE UPLOADED?? '+key);
						PhoneSync.Instance.delaySyncUploads(1);
						PhoneSync.Instance.alreadyDoingSyncUpload=0;
						return;
					}
					PhoneSync.Instance.alreadyDoingSyncUpload=0;
					obj.keys.shift();
					PhoneSync.Instance.save(obj, function() { // remove PhoneSync.Instance item from the queue
						PhoneSync.Instance.delaySyncUploads(1);
						PhoneSync.Instance.delaySyncDownloads();
						if (ret) {
							PhoneSync.Instance.options.onUpload(key, ret);
						}
					}, true);
				},
				function(err) { // fail
					clearTimeout(window.syncUploadsClearTimeout);
					console.log('upload failed');
					PhoneSync.Instance.alreadyDoingSyncUpload=0;
					PhoneSync.Instance.delaySyncUploads();
					PhoneSync.Instance.delaySyncDownloads();
				}
			);
		});
	});
};
PhoneSync.prototype.tablesLastUpdateClear=function() {
	for (var i=0;i<PhoneSync.Instance.options.tables.length;++i) {
		PhoneSync.Instance.tables[PhoneSync.Instance.options.tables[i]]={
			'lastUpdate':'0000-00-00 00:00:00'
		};
	}
};
(function() {
	var timeouts = [],
	messageName = 'zero-timeout-message';
	function setZeroTimeoutPostMessage(fn) {
		timeouts.push(fn);
		window.postMessage(messageName, '*');
	}
	function setZeroTimeout(fn) {
		setTimeout(fn, 0);
	}
	function handleMessage(event) {
		if (event.source == window && event.data == messageName) {
			if (event.stopPropagation) {
				event.stopPropagation();
			}
			if (timeouts.length) {
				timeouts.shift()();
			}
		}
	}
	if (window.postMessage) {
		if (window.addEventListener) {
			window.addEventListener('message', handleMessage, true);
		}
		else if (window.attachEvent) {
			window.attachEvent('onmessage', handleMessage);
		}
		window.setZeroTimeout = setZeroTimeoutPostMessage;
	}
	else {
		window.setZeroTimeout = setZeroTimeout;
	}
}());
