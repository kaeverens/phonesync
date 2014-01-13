function PhoneSync(params, callback) {
	this.options={
		'dbName':'tmp',
		'updatesUrl':'', // URL of the API
		'ready':function() { // called when the database is initialised
		},
		'tables':[], // list of tables to be synced
		'urls':{},
		'onDownload':function() { // called when a new item is downloaded
		},
		'onUpload':function() { // called when an item is uploaded
		},
		'onDelete':function() { // called when a key is deleted
		}
	};
	$.extend(this.options, params);
	this.db=false;
	this.fs=false;
	this.loggedIn=false;
	this.tables={};
	this.cache={};
	for (var i=0;i<this.options.tables.length;++i) {
		this.tables[this.options.tables[i]]={
			'lastUpdate':'0000-00-00 00:00:00'
		}
	}
	var that=this;
	if (!Date.toYMD) {
		function Date_toYMD() {
			var year, month, day;
			year = String(this.getFullYear());
			month = String(this.getMonth() + 1);
			if (month.length == 1) {
				month = "0" + month;
			}
			day = String(this.getDate());
			if (day.length == 1) {
				day = "0" + day;
			}
			return year + "-" + month + "-" + day;
		}
		Date.prototype.toYMD = Date_toYMD;
	}
	if (/http:\/\//.test(document.location.toString())) {
		setTimeout(function() {
			that.syncDownloads();
			that.syncUploads();
		}, 100);
		that.options.ready(this);
	}
	else {
		window.requestFileSystem(
			LocalFileSystem.PERSISTENT, 0,
			function(filesystem) {
				var entry=filesystem.root;
				entry.getDirectory(that.options.dbName,
					{'create':true, 'exclusive':false},
					function(root) {
						that.fs=root;
						setTimeout(function() {
							that.syncDownloads();
							that.syncUploads();
						}, 100);
						that.options.ready(that);
						that.get('_tables', function(ret) {
							if (ret===null) {
								return;
							}
							$.extend(that.tables, ret.obj);
						});
					}
				);
			},
			null
		);
	}
}
PhoneSync.prototype.api=function(action, params, success, fail, noNetwork) {
	var _v=1;
	var that=this;
	if (window.device===undefined || window.device===null) {
		console.error('no network');
		if (noNetwork) {
			return noNetwork();
		}
		return setTimeout(function() {
			this.api(action, params, success, fail);
		}, 100);
	}
	var uid=0;
	if (window.userdata) {
		params._userdata={
			'username':userdata.username,
			'password':userdata.password
		};
		uid=userdata.id;
	}
	else if (window.credentials) {
		params._userdata={
			'username':credentials.email,
			'password':credentials.password
		};
		uid=credentials.user_id;
	}
	var url=this.options.urls[action]+'/_v='+_v+'/_t='+(new Date).toYMD();
	var lastUpdates={};
	$.each(this.tables, function(k, v) {
		lastUpdates[k]=v.lastUpdate;
	});
	params._lastUpdates=lastUpdates;
	params._uuid=(device&&device.uuid)?device.uuid:'no-uid|'+uid;
	this.uuid=params._uuid;
	$.post(
		url,
		params,
		function(ret) {
			if (!ret) {
				console.error('error while sending request');
				fail({'err':'error while sending request'});
			}
			else if (ret.error) {
				if (!fail) {
					fail=function(ret) {
						console.error(JSON.stringify(ret));
					}
				}
				fail(ret);
			}
			else {
				if (action=='login') {
					window.userdata=ret;
					that.loggedIn=true;
				}
				success(ret);
			}
		}
	);
}
PhoneSync.prototype.get=function(key, callback) {
	if (this.cache[key]) {
		return callback(this.cache[key]);
	}
	var that=this;
	this.fileGetJSON(key,
		function(obj) {
			that.cache[key]=obj;
			return callback(obj);
		},
		function() {
			callback(null);
		}
	);
}
PhoneSync.prototype.getAll=function(key, callback) {
	var keys=[];
	if (this.cache[key]) {
		var keys=this.cache[key].obj;
	}
	else {
		this.get(key, function(ret) {
			if (ret===undefined || ret===null) {
				return;
			}
			keys=ret.obj||[];
		});
	}
	var rows=[];
	for (var i=0;i<keys.length;++i) {
		this.get(key+'-'+keys[i], function(ret) {
			rows.push(ret);
		});
	}
	callback(rows);
}
PhoneSync.prototype.delete=function(key, callback, nosync) {
	delete this.cache[key];
	if (/-/.test(key)) {
		this.idDel(key.replace(/-[^-]*$/, ''), key.replace(/.*-/, ''));
	}
	if (callback) {
		callback();
	}
	this.fs.getFile(key, {create: false, exclusive: false}, function(file) {
		file.remove();
	});
	this.options.onDelete(key);
}
PhoneSync.prototype.save=function(obj, callback, nosync) {
	this.cache[obj.key]=obj;
	if (/-/.test(obj.key)) {
		var id=obj.obj && obj.obj.id ? obj.obj.id : obj.id;
		this.idAdd(obj.key.replace(/-[^-]*$/, ''), id);
	}
	if (callback) {
		callback();
	}
	if (!nosync) {
		this.addToSyncUploads(obj.key);
	}
	this.filePutJSON(obj.key, obj);
}
PhoneSync.prototype.addToSyncUploads=function(key) {
	var table=key.replace(/-.*/, '');
	if ($.inArray(table, this.options.tables)==-1) {
		return;
	}
	var that=this;
	this.get('_syncUploads', function(ret) {
		if (!ret || ret===undefined) {
			ret={
				'key':'_syncUploads',
				'keys':[]
			}
		}
		if ($.inArray(key, ret.keys)!=-1) {
			return;
		}
		ret.keys.push(key);
		that.save(ret, false, true);
	});
	clearTimeout(window.PhoneSync_timerSyncUploads);
	window.PhoneSync_timerSyncUploads=setTimeout(function() {
		that.syncUploads();
	}, 100);
}
PhoneSync.prototype.idAdd=function(name, id) {
	id=''+id;
	var that=this;
	this.get(name, function(ret) {
		if (ret===undefined || ret===null) {
			ret={
				'obj':[]
			};
		}
		if ($.inArray(id, ret.obj)===-1) {
			ret.obj.push(id);
			that.save({
				'key':name,
				'obj':ret.obj
			}, false, true);
		}
	});
}
PhoneSync.prototype.idDel=function(name, id) {
	id=''+id;
	var that=this;
	this.get(name, function(ret) {
		if (ret===undefined || ret===null) {
			ret={
				'obj':[]
			};
		}
		var arr=[];
		for (var i=0;i<ret.obj.length;++i) {
			if (id == ret.obj[i]) {
				continue;
			}
			arr.push(ret.obj[i]);
		}
		that.save({
			'key':name,
			'obj':ret.obj
		}, false, true);
	});
}
PhoneSync.prototype.syncDownloads=function() {
	clearTimeout(window.PhoneSync_timerSyncDownloads);
	var that=this;
	if (!this.loggedIn) {
		window.PhoneSync_timerSyncDownloads=setTimeout(function() {
			that.syncDownloads();
		}, 3000);
		return;
	}
	this.api(
		'syncDownloads', {},
		function(ret) {
			var deletes=[];
			$.each(ret, function(k, v) {
				if (!$.isArray(v)) {
					return;
				}
				if (k=='_deletes') {
					deletes=v;
				}
				var tableUpdatesChanged=false;
				for (var i=0;i<v.length;++i) {
					var obj=v[i];
					if (!that.tables[k].lastUpdate
						|| obj.last_edited>that.tables[k].lastUpdate
					) {
						that.tables[k].lastUpdate=obj.last_edited;
						tableUpdatesChanged=true;
					}
					if (k!=='_deletes') {
						(function(k, obj) {
							that.get(k+'-'+obj.id, function(ret) {
								if (ret===null) {
									that.options.onDownload(k+'-'+obj.id, obj);
								}
								if (that.uuid==obj.uuid) {
									that.get(k+'-'+obj.id, function(ret) {
										if (ret===null || ret.obj.uuid!=that.uuid) {
											that.save({
												'key':k+'-'+obj.id,
												'obj':obj
											}, false, true);
										}
									});
								}
								else {
									that.save({
										'key':k+'-'+obj.id,
										'obj':obj
									}, false, true);
								}
							});
						})(k, obj);
					}
				}
				if (tableUpdatesChanged) {
					that.save( { 'key':'_tables', 'obj':that.tables }, false, true);
				}
			});
			for (var i=0;i<deletes.length;++i) {
				that.delete(deletes[i].key);
			}
		},
		function(err) {
			console.log('failed');
			console.log(JSON.stringify(err));
		}
	);
	window.PhoneSync_timerSyncDownloads=setTimeout(function() {
		that.syncDownloads();
	}, 60000);
}
PhoneSync.prototype.syncUploads=function() {
	clearTimeout(window.PhoneSync_timerSyncUploads);
	var that=this;
	if (window.PhoneSync_timerSyncUploads_uploading) {
		window.PhoneSync_timerSyncUploads=setTimeout(function() {
			that.syncUploads();
		}, 100);
		return;
	}
	this.get('_syncUploads', function(ret) {
		if (!ret || ret===undefined || ret.keys.length==0) {
			return;
		}
		var key=ret.keys.shift();
		that.get(key, function(ret) {
			window.PhoneSync_timerSyncUploads_uploading=true;
			that.api(
				'syncUploads', ret,
				function(ret) { //  success
					if (ret) {
						that.options.onUpload(key, ret);
					}
					window.PhoneSync_timerSyncUploads_uploading=false;
					clearTimeout(window.PhoneSync_timerSyncUploads);
					window.PhoneSync_timerSyncUploads=setTimeout(function() {
						that.syncUploads();
					}, 100);
				},
				function(ret) { // fail
					console.log('fail', ret);
					window.PhoneSync_timerSyncUploads_uploading=false;
					clearTimeout(window.PhoneSync_timerSyncUploads);
					window.PhoneSync_timerSyncUploads=setTimeout(function() {
						that.syncUploads();
					}, 15000);
				}
			);
		});
	});
}
PhoneSync.prototype.filePutJSON=function(name, obj) {
	var json=JSON.stringify(obj);
	this.fs.getFile(name, {'create':true, 'exclusive':false},
		function(entry) {
			entry.createWriter(function(writer) {
				writer.write(json);
			});
		}
	);
}
PhoneSync.prototype.fileGetJSON=function(name, success, fail) {
	this.fs.getFile(name, {'create':false, 'exclusive':false},
		function(entry) {
			entry.file(
				function(file) {
					var reader=new FileReader();
					reader.onloadend=function(evt) {
						if (evt.target.result) {
							success(JSON.parse(evt.target.result));
						}
						else {
							console.warn('file does not exist: '+name);
							fail();
						}
					}
					reader.readAsText(file);
				},
				fail
			);
		},
		fail
	);
}
PhoneSync.prototype.nuke=function(callback) {
	var directoryReader=this.fs.createReader();
	directoryReader.readEntries(function(entries) {
		for (var i=0; i<entries.length; ++i) {
			entries[i].remove();
		}
	});
	for (var i=0;i<this.options.tables.length;++i) {
		this.tables[this.options.tables[i]]={
			'lastUpdate':'0000-00-00 00:00:00'
		}
	}
	this.cache={};
	callback();
}
PhoneSync.prototype.rekey=function(table, oldId, newId) {
	var that=this;
	this.get(table+'-'+oldId, function(obj) {
		obj.key=table+'-'+newId;
		obj.obj.id=newId;
		that.save(obj);
		that.delete(table+'-'+oldId);
	});
}
