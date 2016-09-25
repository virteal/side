# side.js
## Synchronous javascript thanks to caching &amp; pure functions.


This is a tool to make it easier to write asynchronous AWS Lambda functions.
It helps avoid "callback hell" and/or promises for those who prefer a more
traditionnal synchronous style of programming. It works outside of AWS
Lambda too.


```javascript
Side( function( side ){
  try{
    var a = side.slot( cb => async_read( "a", cb ) );
    var b = side.slot( promise_read( "b" ) );
    signal_success( a + b );
  }catch( err ){ 
    side.catch( err );
    signal_error( err );
  }
} );
```

Don't:

```javascript
async_read( "a", function( err, a ){
 if( err ){
   signal_error( err );
   return;
 }
 async_read( "b", function( err, b ){
   if( err ){
     signal_error( err );
     return;
   }
   signal_success( a + b )
 } ); 
} );
```

Nor:

```javascript
promise_read( "a" ).then( 
 function( a ){ 
   promise_read( "b" ).then( 
     function( b ){
       signal_success( a + b );
     },
     function( err ){ 
       signal_error( err );
     }
   );
 },
 function( err ){ 
   signal_error( err );
 }
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

To use async functions, sync functions must cache async results. Side.slot()
and Side.cache() help about that. They work with promises too.
Please note that each side action has its own new cache. To manage caches
with long lived results, "memoize" type of solutions may help; there are
multiple npm packages that implement it and other caching schemes.

The implementation uses promises. Action objects created using Side() are
thenables. As a result, Promise.all() and Promise.race() work on them.

Unfortunately this does not work for "write" type of code. Such code cannot
be run multiple times or else multiple writes accumulate and this is not
usually the desired effect. Hence, write code cannot run synchronously
unless some special code detects and/or avoid double writes.

A solution is to postpone writes until all reads are done, when possible.
Another one is to provide routines to erase side effects, routines to be run
when a block occurs. In that case, code is included in a transaction and
no other side action can run until the transaction is done. This is a
kind of global mutex over a global shared memory. A third solution is
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

    // ... cache for costly procedures or to avoid double writes ...
    var r = it.has( "r" ) ? it.get() : it.set( "r", compute_r() );

    // ... logging, with filtering over multiple retries ...
    it.log( "'b' was", it.cached.b );

    // ... reversible side effects ...
    it.restore( ()=> some_global.value, ( r )=> some_global.value = r );
    some_global.value = "change 1";

    // ... idem but with ability to handle more complex changes ...
    var restore = some_global.value2;
    it.restore( function(){ some_global.value2 = restore; } );
    some_global.value2 = "change 2";
 
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
for something, it needs to describe what will happen next when that
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
they just produce a result depending on their parameters, without modifying
anything around. The same pure function called a million times with the same
parameter will always produce the same result.

Using lots of pure functions is typical of a style of programming known as
"functional programming". The absence of side effects has many benefits,
makes it much easier to test and debug functions. It has a major drawback:
nothing changes, much as if the pure function had never been called.

Consequentely, pure functions need to be called by some much less pure
ones, in order to produce some observable change.

The Side module uses pure functions to simulate blocking functions.
From the point of vue of the function code, it's like if the function
could be interrupted and restarted, much like blocking functions.


#### cache

Obviously, something need to change to successfully restart an interrupted
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
occur: javascript functions can be written as if they could block.

This works only with "read" type of functions. "write" type of functions,
functions that need to change things, that need to produce side effects, are
a different story.

Fortunately, "read" functions are usually much more frequent than "write"
functions, making Side useful often.


#### side effects

To help with "write" type function, Side provides tools to encapsulate side
effects in order to produce them in a well controlled manner. Manners actually.
Three of them.


#### transactions

#### cache entries

#### slots


## API

```javascript
var Side = require( "side" );
var new_side_action = Side( function(){ return "ok"; } );
```

The Side module exports a function that creates new side actions like
`side.start()` does.


### side.start( f, ctx, p1, p2, ... )

This is similar to `Side( ... )`, it starts a new side action. The new side
action is a child action of the parent side action.

`f` is the only mandatory parameter, it is expected to be a function object. 
If it is a thenable promise instead, the outcome of the new side action depends
on the outcome of that promise.

Function `f` is called immediately. It either returns a result, raise an
exception or "blocks". If it blocks (a special exception) then function `f`
will typically run again later when the reason for the block is removed.

The signature of `f` is `f( side_action, ctx, p1, p2, ... )`. `side_action` is the
newly created side action. ctx is the value provided when the side action was
started or an empty `{}` object. The other parameters are the ones provided to
`side.start()`.

`side.start()` returns a new Side action object. With the exception of the
`Side()` function itself, all other API methods are member functions of such
Side action objects.

Unless the new side action is created by the special root action (using
`side.root.start()` or the `Side()` factory), it is a sub side action of its
parent action. The parent action won't terminate until all its child side
actions are done.


### side.get()

When the outcome of a side action is available, `side.get()` will provide it,
either as a normal value or by raising an exception. If the outcome is not
available then `side.get()` "blocks" by raising a special exception.


### side.then( ok, ko )

Side actions are thenable promises. The outcome of the side action is delivered
to either the `ok` or `ko` callback depending on success/failure. Failure is
detected when some unhandled exception is raised by the side action. In that
case, the error is delivered to the `ko` callback.


### side.run( f, ctx, p1, p2, ... )

This is a shorthand for `side.start( ... ).get()`.


### side.retry() & side.wait()

When a function needs to block it simply raises a special exception using 
`side.wait()`. When the blocked function can be deblocked, it calls the 
function previously acquired using `side.retry()`.

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


### side.catch( err )

When an exception is raised it can be either a regular exception or the
special exception used to signal that the current side action needs to block.

Using `side.catch( err )`, such special exceptions signaling blocks will be
rethrown. See also `side.is_block()`.

Usage:

```javascript
try{
  ...
}catch( error ){
  side.catch( error );
  // ... process 'normal' exceptions
}
```

### side.is_block( err )

Like `side.catch()` but returning `true` if the parameter is the special
exception signaling blocks.


### side.detach()

When a side action is created, it is initially a child side action of another
action. That parent action cannot success until all such child side actions are
done. `side.detach()` remove a side action from the list of sub actions of its
parent action ; a parent action that therefore does not need anymore to wait
for the sub action to succeed.

Usage:
```javascript
 side.start( f ).detach();
```

Please note that `side.root.start( f )` will produce a similar effect because the
new side action is directly attached to the special root side action instead of
beeing attached to the action that started it.
