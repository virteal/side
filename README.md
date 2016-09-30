# side.js
## Synchronous javascript thanks to caching & pure functions.


This is a tool to make it easier to write asynchronous AWS Lambda functions.
It helps avoid "callback hell" and/or promises for those who prefer a more
traditionnal synchronous style of programming. It works outside of AWS
Lambda too.


```javascript
Side( function( side ){
  try{
    var a = side.slot( cb => async_read( "a", cb ) );
    var b = side.slot( () => promise_read( "b" ) );
    signal_success( a + b );
  }catch( err ){ side.catch( err );
    signal_error( err );
  }
} );
```

Don't:

```javascript
async_read( "a", function( err, a ){
 if( err )return signal_error( err );
 async_read( "b", function( err, b ){
   if( err )return signal_error( err );
   signal_success( a + b )
 } ); 
} );
```

Nor:

```javascript
promise_read( "a" ).then( 
  ( a ) => promise_read( "b" ).then( 
    ( b ) => signal_success( a + b ),
    ( err ) => signal_error( err )
  ),
  ( err ) => signal_error( err )
);
```

The idea is fairly simple. A synchronous function is a function that does
not need to "block". But blocking is often necessary. Can it be considered
a recoverable 'exception' however?

Yes but only when nothing irreversible was done before the block, ie when
there was no "side effects". In that case, the same code can run again,
possibly multiple times, until no more reasons to block remain.

With a good cache policy, running the same code multiple times is ok
performance wise when the associated cost is low compared to a cache
miss, a miss that typically involves an IO operation.

To use async functions, sync functions must cache async results. `Side.slot()`
and `Side.cache()` help about that. They work with promises too.
Please note that each side action has its own new cache. To manage caches
with longer lived results, "memoize" type of solutions may help; there are
multiple npm packages that implement it and other caching schemes.

The implementation uses promises. Side action objects created using `Side()` are
thenables. As a result, `Promise.all()` and `Promise.race()` work on them.

Unfortunately this does not work for "write" type of code. Such code cannot
run multiple times or else multiple writes accumulate and this is not
usually the desired effect. Hence, write code cannot run synchronously
unless some special code detects and/or avoid double writes.

A solution is to postpone writes until all reads are done, when possible.
Another one is to provide routines to erase side effects, routines to run
when a block occurs. In that case, code is included in a transaction and
no other side action can run until the transaction is done. A third solution is
to avoid double writes by remembering that a write was done already, ie
caching writes.


### Lambda usage:

```javascript
exports.my_function = Side.lambda( function( event ){
  // ... build result ... using Side methods & Side.context
  return result;
} );
```

### Other usages:

```javascript
function do( it, context, param ){
  try{
  
    // ... cache for async functions ...
    it.cache( "a", ()=> async_read( "some key", it.fill() ) );

    // ... delayed write actions, ran once, on success
    it.write( ()=> console.log( "Success, 'a' was", it.cached.a ) );

    // ... cache for promises ...
    var b = it.cache( "b", promise_read( it.cached.a ) );

    // ... logging, with filtering over multiple retries ...
    it.log( "'b' was", b );

    // ... cache for costly procedures or to avoid double writes ...
    var r = it.has( "r" ) ? it.get() : it.set( "r", compute_r() );

    // ... reversible side effects ...
    it.restore( ( r )=> some_global.value = r, some_global.value );
    some_global.value = "changed";

    // ... sub side actions ...
    var sub = it.side( some_code ).get();
    var sub2 = it.run( some_code );
 
    // ... shared cache entries and context ...
    it.share( "a" );
    it.side( function( side2 ){
      return use_it( side2.context, side2.cache( "a" ) );
    }, it.context );

    return "some_result: " + param + a + b;

  // ... handle exceptions ...
  }catch( error ){
    it.catch( error );
    console.error( "an error occurred", error );
    return "sorry";
  }
}

Side( do, config, "x" ).then( r => console.log( r ) );
```

### Concepts

#### blocking functions

In most computer languages a "blocking" function is a function that
can be interrupted and later restarted at that point of interruption.

In javascript only special "generator" functions behave this way.
Normal functions never block. As a result, javascript is mostly a
single threaded synchronous language, without concurrency.

Instead, javascript is "event based". When a function needs to wait
for something, it has to describe what will happen next when that
something happens. This is typically done using "callbacks".

Interrupting a function is easy, one just needs to throw an exception.
If that exception is not handled by the current function then it is
propagated to the caller function, up to the top of the call chain if
no functions at all handle the exception.

What is impossible is to restart the interrupted function. However, any
function in the call chain can handle the exception and can therefore
decide to retry the interrupted function, by restarting it, typically after
some event occured that the interrupted function was expecting.


#### pure functions

Restarting a function from its beginning is very different from restarting
it from some well known point of interruption. However, in some cases, the
effects are the same. Specially with "pure" functions.

Such special functions are called "pure" because they have no "side effects",
they just produce a result depending only on their parameters, without modifying
anything around. The same pure function called a million times with the same
parameters will always return the same result.

Using lots of pure functions is typical of a style of programming known as
"functional programming". The absence of side effects has many benefits,
it makes it much easier to test and debug functions. It has a major drawback:
nothing changes, much as if the pure function had never been called.

Consequentely, pure functions need to be called by some much less pure
ones, in order to produce some observable change.

The Side module uses pure functions to simulate blocking functions.
From the point of view of the function code, it's like if the function
could be interrupted and restarted, much like blocking functions.


#### cache

Obviously, something needs to change to successfully restart an interrupted
function. Maybe it is the result of some IO operation that became available.
Maybe it is some promise that is fulfilled. Something. A something that
the interrupted function had to take care of, had to make happen. By
initiating some action.

Such functions are not pure anymore. If ran twice, they will initiate two
actions. That's problematic. Unless, somehow, a mechanism prevent the
duplicate actions. A "cache" is such a mechanism.

A typical scenario is a function that needs to access some data. But that
data is not available immediately, it needs to be provided by some
external resource that must be queried. The javascript function cannot
block until the data is provided, it cannot wait, it must return.

However, once the data becomes available, it can be stored locally. As a result,
if the same data is needed again, this time it can be provided immediately,
with no block, with no interruption. If the same function is run again, this
time it won't need to be blocked or interrupted, it will access the data
in a synchronous way.

This is how Side works. Using pure functions and caches. And the magic
begins: javascript functions can be written as if they could block.

But this works only with "read" type of functions. "write" type of functions,
functions that need to change things, that need to produce side effects, are
a different story.

Fortunately, "read" functions are usually much more frequent than "write"
functions, making Side useful often.


#### side effects

To help with "write" type functions, Side provides tools to encapsulate side
effects in order to produce them in a well controlled manner. Manners actually.
Three of them.

#### delayed writes

#### transactions

#### cache entries & slots


## API - side actions management

```javascript
var Side = require( "side" );
var new_side_action = Side( function(){ return "ok"; } );
```

The Side module exports a function that creates new side actions like
`side.start()` does. That function is also accessible via any side action
object using either `side.Side` or `side.Side`.


### Side.it, Side.root - access to current and root side actions

When a side action runs, global `Side.it` references it. When a new side
action is created while no side action is running, its parent is the
special root side action.

As a convenience, `.it` and `.root` are also available on side action objects
in addition to their availability on the global `Side()` factory.


### side.start( f, ctx, p1, p2, ... ) - starts a new side action

This is similar to `Side( ... )`, it starts a new side action. The new side
action is a child action of the parent side action. That parent needs to be
the current side action or else an error is raised.

`f` is the only mandatory parameter, it is expected to be a function object. 
If it is a thenable promise instead, the outcome of the new side action depends
on the outcome of that promise.

Function `f` is called immediately. It either returns a result, raises an
exception or "blocks", using `side.wait()` somehow. If it blocks (a special
exception) then function `f` will typically run again later when the reason for
the block is removed.

The signature of `f` is `f( side_action, ctx, p1, p2, ... )`. `side_action` is the
newly created side action. `ctx` is the value provided when the side action was
started or an empty `{}` object. The other parameters are the ones provided to
`side.start()`.

`side.start()` returns a new Side action object. With the exception of the
`Side()` function itself, all other API methods are member functions of such
Side action objects. When not otherwise specified, member functions are chainable
and return the side object they were invoked upon.

Unless the new side action is created by the special root action (using
`side.root.start()` or the `Side()` factory), it is a sub side action of its
parent action. The parent action won't terminate until all its child side
actions are done.


### side.get() - gets side action outcome, or blocks

When the outcome of a side action is available, `side.get()` will provide it,
either as a normal value or by raising an exception. If the outcome is not
available then `side.get()` "blocks" by raising a special exception.


### side.run( f, ctx, p1, p2, ... ) - runs a new side action

This is a shorthand for `side.start( ... ).get()`.


### side.then( ok, ko ) - registers callbacks to process side action outcome

Side actions are thenable promises. The outcome of the side action is delivered
to either the `ok` or `ko` callback depending on success/failure. Failure is
detected when some unhandled exception is raised by the side action. In that
case, the error is delivered to the `ko` callback.


### side.retry() & side.wait() - blocks and later retries a side action

When a function needs to block, it simply raises a special exception using 
`side.wait()`. When the blocked function can be deblocked, something need to
call the function previously acquired using `side.retry()`.

Usage:
```javascript
if( data_is_available() ){
  return data_value();
}else{
  var retry = side.retry();
  async_get_data( function( err, value ){
    data_fill( err, value );
    retry();
  } );
  side.wait();
}
```

If `side.wait()` is called without `side.retry()` beeing called first, then it
does nothing, assuming no retry is needed.

As a convenience `side.wait( a_promise )` will automatically call `side.retry()`
and will use its result when the promise is delivered. Until that, it blocks
the action.


### side.end( result ) - set result of side action with no retries

After a call to `side.end()`, the next retry will actually terminate the
side action. This is useful to avoid an extra attempt when the last step of
a side action blocks, specially when that last step performs a side effect.


### side.catch( err ) - propagates blocks

When an exception is raised it can be either a regular exception or the
special exception used to signal that the current side action needs to block.

Using `side.catch( err )`, such special exceptions will be detected and 
rethrown.

Usage:

```javascript
try{
  ...
}catch( error ){
  side.catch( error );
  // ... process 'normal' exceptions
}
```


### side.detach() - detach sub side action from parent side action

When a side action is created, it is initially a child side action of another
action. That parent action cannot succeed until all such child side actions are
done. `side.detach()` remove a side action from the list of sub actions of its
parent action ; a parent action that therefore does not need anymore to wait
for the sub action to succeed.

Usage:
```javascript
 side.start( f ).detach();
```


### side.abort( error ) - premature termination of a pending side action

If a side action is blocked waiting for something then it can be aborted. The
option `error` will set the outcome, it defaults to a "Side abort" Error object.

When applied to the currently running action, that action is immediately blocked,
an exception about that is immediately raised.


### side.blocked(), side.pending(), side.done(), side.success(), side.failure()

The state of a side action evolves when its code runs. As long as attempts are
required to make it succeed, `side.pending()` will return true.

When the side action is fully terminated, `side.done()` will return true. 
`side.success()` and `side.failure()` then tell weither the outcome is a success
or an error. See `side.get()` also to access the outcome.

When a side action is neither pending nor done, it is terminating. This is a
special phase when delayed sub actions are run to process side effects
typically, see `side.write()` and `side.restore()`.


## API - side effects and action states

### side.write( fn ) - registers code to run when side action succeeds

One safe way to handle side effects is to postpone them until the end of a
side action. That way, when a side action is run multiple times because of
blocks, side effects are still done once only.

The provided `fn` function is run in a side sub action. It will run once only
because it is expected to block at most once and a call to `side.end()` is
for that purpose done before the side sub action starts. Functions are run in
sequence, in the registration order, fifo style.

When a side action fails or blocks, the registered functions are not run at all.


### side.finally( fn ) - registers code to run when side action terminates

Like `side.write()` but after. For traces typically, `side.log()` uses it.


### side.log(), side.warn(), etc - like console.log() but without duplicates

When `console.log()` is called by a side action, the same message will be
issued multiple times when the side action blocks. Using `side.log()` such
duplicates are avoided. Messages are issued once only, when the side action is
done.


### side.restore( fn, val, no_mutex ) - manage reversible side effects

Because a side action runs multiple times when blocks occur, side effects, if
any, often need to be reversible. As a result, either all side effects are done,
when the side action succeeds, or all side effect are erased, when the side action
fails or blocks.

Additionnaly, after `side.restore()` is called, no other side action can run
until the side action is done. The side action hence become a "transaction" that
either commits or rollsback. Beware that no other side action will run even if
the side action blocks. Much as if the side action had acquired a mutex on the
global state. This behavior can be avoided by using the optional third parameter.

The second parameter when present is provided to the `fn` function when/if it is
called after a block or a failure.

By using `side.restore()` a function can behave as a pure function until the
last minute, it therefore can run multiple times safely, with side effects
left in place only when the side action succeeds, not when it blocks or fails.


## API - caching

The trick to make side actions look like synchronous functions is to restart
them when they need to block. The next time the function runs, something must
have changed or else the action would get restarted forever.

One way to manage such changes is to initiate them and collect their results
in some cache where they will be available in a synchronous manner. Side
provides two types of such caches: named cache entries and slots.

Named cache entries are identified by a key. Slots are identified by the order
they are allocated.

### side.slot( fn ) - allocate and fill a slot

If `fn` is a function then its signature is expected to be `f( cb )` where
`cb` is a nodejs style callback, `cb( error, result)`. The function is expected
to initiate an action that will eventually result in a call to the callback.

That function is called once only. The next time the side action is restarted,
it is not called and it is the result stored by the callback that is returned.

Usage:

```javascript
var a = side.slot( cb => async_read( "something", cb ) );
```

If the `fn` function returns a thenable promise, that is detected and the
callback is automatically attached using `then( ok, ko )`.

As a convenience, `Side()` is equivalent to `Side.it.slot()`, it allocates
a new empty slot in the current side action.

Usage:
```javascript
var b = side.slot( () => promise_read( "something" ) );
```

### side.fill() - manual slot handling

For more complex cases, one can manage the slot in a more manual style using
`side.fill()`. It returns a nodejs callback that will fill the last allocated
slot and will restart the side action.

Usage:

```javascript
var c = side.slot();
if( side.needs( c ){ 
  async_read( "something", side.fill() );
  side.wait();
}
```

### side.needs( thing ) - detect empty slots

When a slot is allocated using `var x = side.slot()` it is initially empty and
needs to be filled. See `side.fill()`


### side.key( a, b, c, ... )

To name cache entries, one needs a key. It is a string. In some cases, when
lots of cache entries are required, that string needs to be built from multiple
parts. This is done by concatenating the JSON represention of these parts.

Once a key was built, the next call to `side.key()` (without parameters) will
return it.

Usage:

```javascript
var my_key = side.key( "mem", x, y, z );
if( !side.has( my_key ){
  var retry = side.retry();
  async_read( x, y, z, function( error, result ){
    side.set( my_key, result, error );
    retry();
  } );
  side.wait();
}
var result = side.get();
```

### side.has( key ) - detect empty cache entries

If the content of a named cache entry has not been set yet then `side.has( name )`
returns false.

Usage:

```javascript
var result = side.has( "r" ) ? side.get() : side.set( "r", compute_r() );
```

### side.get( key ) - get content of cache entry

This will return the content of a named cache entry. If that entry has not been
filled yet, it will block the side action by raising a special exception.

If `key` is not provided, it is the last seen key that is used instead.

If the cache entry was filled with an error, using `side.set( "x", null, error )`,
then the error is rethrown.

As a convenience, `Side( key )` is equivalent to `side.it.get( key )`, it accesses
the designated cache entry of the current side action.


### side.set( key, value, error ) - set cached value

If `error` is provided, access to the cache entry will raise it as an exception, the
`value` is ignored.

If `value` is not provided, `side.set( n )` will set entry `n` to boolean true.


## Side.ize( fn ) - efficiency

Because every block requires a new attempt, faking synchronous code with pure
functions can be inefficient.

For exemple, if function A processes a list of 10 items by calling function B 
10 times and if function B needs to block 3 times then function A may have to
be restarted a total of 30 times, that's a lot.

One way to reduce that is to turn the B function into a "sideized" function, a
function that will create sub side actions. That way, function A will be
restarted 10 times instead of 30.

Usage:
```javascript

function concat_labels( items ){
  var fast_get_label = Side.ize( get_label );
  var msg = "";
  items.forEach( item, function(){
    msg += fast_get_label( item );
  } );
}
```

If a blockin function is always called in the context of a running side action,
it can as well be defined as a sideized function straigth away.

Usage:

```javascript

User.prototype.get_profile = Side.ize( function(){
  var result = {
    name: this.name,
    log_history: this.get_log_history()
  };
  result.time_last_log = result.log_history[ result.log_history.length - 1 ].timestamp;
  return result;
} );
```
