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

Side( do, config, "x" ).then( ( r ) => console.log( r ) );
```
