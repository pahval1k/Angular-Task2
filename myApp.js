'use strict';


function Scope() {
    this.$$watchers = []; // list of registered watchers 
    this.$$asyncQueue = []; // list of delayed functions. fired whether inside current digest cycle or before next digest cycle. 
    this.$$postDigestQueue = []; // list of delayed functions. fired whenever digest will be finished. 
    this.$$phase = null; // variable that contains information about whether digest or apply is being fired. should exist for $evalAsync ($evalAsync should be sure that delayed function will be fired soon, not when somebody fires $digest
}

/*
    function that informs about fired digest cycle
*/
Scope.prototype.$beginPhase = function (phase) {
    if (this.$$phase) { // if digest cycle is already in progress 
        throw this.$$phase + ' already in progress.';
    }
    this.$$phase = phase;
};

/*
    function that informs about finished digest cycle
*/
Scope.prototype.$clearPhase = function () {
    this.$$phase = null;
};

/*
    function has been defined for case when observed value is undefined first time
    (old value in the digest cycle is undefined by default in the first iteration, so listener might be not called)
*/
function initWatchVal() {}

/*
    function that registers watcher
*/
Scope.prototype.$watch = function (watchFn, listenerFn, valueEq) {
    if (watchFn) { // First parameter 'watchFn' should be mandatory. listenerFn and valueEq are allowed to be optional. otherwise throws exception
        var self = this;
        var watcher = {
            watchFn: watchFn, // value that should be observed 
            listenerFn: listenerFn || function () {}, // listener that will be fired whenever value changes. if this parameter hasn't been passed, empty function would be fired.  
            valueEq: !!valueEq, // boolean variable that determine whether to compare current and previous values by link or value. if this parameter hasn't been passed, it would be turned in false.
            last: initWatchVal // see initWatchVal description
        };
        self.$$watchers.push(watcher); // adding the watcher to the list of registered watchers
        return function () { // returns function that deletes watcher from list (possibility to disable watching function)
            var index = self.$$watchers.indexOf(watcher);
            if (index >= 0) {
                self.$$watchers.splice(index, 1);
            }
        };
    }
    throw "First parameter 'watchFn' should be mandatory";
};


/*
    a variant of $watch() where it watches an array of watchExpressions. 
    If anyone expression in the collection changes the listener is executed
*/
Scope.prototype.$watchGroup = function (watchFns, listenerFn) {

    if (watchFns.length) { //at least one object should be passed
        var self = this;
        var newValues = new Array(watchFns.length);
        var oldValues = new Array(watchFns.length);

        var destroyFunctions = _.map(watchFns, function (watchFn, i) { // returns collection of watchers that can be disabled 
            return self.$watch(watchFn, function (newValue, oldValue) {
                newValues[i] = newValue;
                oldValues[i] = oldValue;
                listenerFn(newValues, oldValues, self);
            });
        });
        return function () { // returns function that deletes all watchers from group 
            _.forEach(destroyFunctions, function (destroyFunction) {
                destroyFunction();
            });
        };

    }

};

/*
    function that compares previous and current value of digest cycle
*/
Scope.prototype.$$areEqual = function (newValue, oldValue, valueEq) {
    if (valueEq) { // it this parameter is true, then it should comparing by value
        return _.isEqual(newValue, oldValue);
    } else { // otherwise it should comparing by link including cases with NaN
        return newValue === oldValue ||
            (typeof newValue === 'number' && typeof oldValue === 'number' &&
                isNaN(newValue) && isNaN(oldValue));
    }
};
/*
    function that look through the list of watchers and returns true if there have been at least one change of observed values. 
    Also fires corresponding listener if observed values have been changed
*/
Scope.prototype.$$digestOnce = function () {
    var self = this;
    var dirty;
    _.forEach(this.$$watchers, function (watch) {
        try {
            var newValue = watch.watchFn(self);
            var oldValue = watch.last;
            if (!self.$$areEqual(newValue, oldValue, watch.valueEq)) {
                watch.listenerFn(newValue, (oldValue === initWatchVal ? newValue : oldValue), self);
                dirty = true;
            }
            watch.last = (watch.valueEq ? _.cloneDeep(newValue) : newValue);
        } catch (e) {
            (console.error || console.log)(e);
        }
    });
    return dirty;
};

/*
    digest cycle. examines all of the $watch expressions and compares them with the previous value
*/
Scope.prototype.$digest = function () {
    var ttl = 10; // max amount of iterations. should be existed to prevent infinity loop (for example, in case when two watchers are observing each other)
    var dirty; // whether there is dirty values
    this.$beginPhase("$digest"); // informs that digest cycle has been fired. should exist for $evalAsync ($evalAsync should be sure that delayed function will be fired soon, not when somebody fires $digest)
    do { // do this block until observed values aren't dirty. this block executes all delayed function from $$asyncQueue
        while (this.$$asyncQueue.length) { // until $$asyncQueue list is not empty 
            try {
                var asyncTask = this.$$asyncQueue.shift(); // removes the first item from the list and returns it 
                this.$eval(asyncTask.expression); // just fires passed function 
            } catch (e) {
                (console.error || console.log)(e);
            }
        }
        dirty = this.$$digestOnce(); // whether there are dirty values in wathers 
        if (dirty && !(ttl--)) { // if values are dirty and amount of iterations is over. 
            this.$clearPhase(); //informs that digest cycle has been finished
            throw "10 digest iterations reached";
        }
    } while (dirty);
    this.$clearPhase(); //informs that digest cycle has been finished

    while (this.$$postDigestQueue.length) { // until $$postDigestQueue list is not empty
        try {
            this.$$postDigestQueue.shift()(); // removes the first item from the list and fires it
        } catch (e) {
            (console.error || console.log)(e);
        }
    }
};

/*
    returns value of passed and executed function with scope as a second parameter 
*/
Scope.prototype.$eval = function (expr, locals) {
    return expr(this, locals);
};

/*
    get optional function and fires it using $eval. also fires $digest in the end. 
*/
Scope.prototype.$apply = function (expr) {
    try {
        this.$beginPhase("$apply"); // informs that $apply phase has been started 
        if (_.isFunction(expr)) { // returns undefined is expr isn't function
            return this.$eval(expr)
        }
    } finally {
        this.$clearPhase(); // informs that $apply phase has been finished
        this.$digest(); // fire $digest cycle 
    }
};

/*
    get delayed function to be executed. 
    fired whether inside current digest cycle or before next digest cycle. 
    call digest on its own as soon as possible in the case of no function (apply, digest) in progress
*/
Scope.prototype.$evalAsync = function (expr) {
    var self = this;
    if (!self.$$phase && !self.$$asyncQueue.length) { // if phase is null and list of $$asyncQueue is empty, then it should be planning digest execution 
        setTimeout(function () {
            if (self.$$asyncQueue.length) {
                self.$digest();
            }
        }, 0);
    }
    self.$$asyncQueue.push({
        scope: self,
        expression: expr
    }); //adding functions in $$asyncQueue list. they are fired whether inside current digest cycle or before next digest cycle. 
};

/*
    adding functions in $$postDigestQueue list. they are executed whenever digest will be finished.
*/
Scope.prototype.$$postDigest = function (fn) { // 
    this.$$postDigestQueue.push(fn);
};

// ------------------------------------- run block -------------------------------------------------//


var scope = new Scope(); // declaring new scope object 
scope.firstValue = undefined; // adding property to the scope object that will be observed. listener of watch function will be fired whenever this value changes
scope.counter = 0; // counter. shows how many times listener of watch function has been fired. 

/* new watch object. first argument is value that should be observed. 
second argument is listener that will be fired whenever first argument changes
$watch returns function that shuould be fired whenever you want to remove observing*/
var removeWatch = scope.$watch(
    function (scope) {
        return scope.firstValue;
    },
    function (newValue, oldValue, scope) {
        scope.counter++;
    }
);

scope.$digest();
console.log(scope.counter); // expects counter to be 1 

scope.firstValue = "abcd";
scope.$apply();
console.log(scope.counter); // expects counter to be 2 because value has been changed


removeWatch();
scope.firstValue = 'no longer incrementing';
scope.$digest();
console.log(scope.counter); // expects counter to be 2 because watch has been disabled

scope.secondValue = undefined;
scope.thirdValue = undefined;
var removeGroup = scope.$watchGroup([
    function (scope) {
            return scope.secondValue;
    },
    function (scope) {
            return scope.thirdValue;
    }],
    function (newValue, oldValue, scope) {
        scope.counter++;
    }
);
scope.$digest();
console.log(scope.counter); // expects counter to be 4 because "removeGroup" variable contains two objects

scope.secondValue = "John Parker";
scope.$digest();
console.log(scope.counter); // expects counter to be 5 because watch in watchGroup has been disabled

removeGroup();
scope.thirdValue = "Peter Parker";
scope.secondValue = "Jenifer Parker";
scope.$digest();
console.log(scope.counter); // expects counter to be 5 because all watchers from watcherGroup have been removed