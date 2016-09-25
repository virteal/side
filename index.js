// side.js
//   Synchronous javascript thanks to caching & pure functions.

"use strict";


// Module definition. See https://github.com/umdjs/umd
(function( root, factory ){
  if( typeof define === 'function' && define.amd ){
    define( [], factory );
  }else if( typeof module === 'object' && module.exports ){
    module.exports = factory();
    if( typeof require === 'function' && require.main === module ){
      module.exports.it.smoke_tests( true /* traces */ )
      .then( ok => process.exit( ok ? 0 : 1 ) );
    }
  }else{
    root.Side = factory();
  }
}( this, function(){


/*
 *  Some global variables, private
 */


// To help debug
var Debug = false;
 
// All side actions are child actions of the root action
var RootAction;

// When running, an action becomes the "current" action
var CurrentAction;

// Unique id for actions, useful to debug
var NextId = 0;
 
// Pending write actions will block normal ones
var Writing = false;

// When using .restore(), a Side action (and subactions) own a global mutex
var Mutex = null;

// Queue of actions to process
var Queue = [];

// Alternative queue when in "writing" mode
var WriteQueue = [];

// Queue of functions to call next time other queues are empty
var IdleQueue = [];

// Easy access to last action that blocked, ie via some kind of "throw Side;"
var Block = null;

// Easy access to last .fill()'s unconsummed result
var Filler = null;


/*
 *  Side action class
 */

function Side( code, ctx, p1, p2, p3, p4, p5 ){
// Creates a new side action.
// The signature of code is f( side, ctx, p1, p2, ... ) where side is the new
// Side action object, ctx is the optional context and p1, p2, etc are other
// parameters provided when the new side action was created.
// When the optional context was provided, it is also made available in the
// global Side.context variable.

  // Syntax sugar, Side(), with no parameters, is Side.slot();
  if( !arguments.length )return Side.slot();

  // Syntax sugar, Side( key, ... ) is Side.cache( key, ... );
  if( typeof code === "string" )return Side.cache.apply( null, arguments );
  
  // Enable both a = Side( ... ) and a = new Side( ... )
  if( !this )return (
  arguments.length === 2 ? new Side( code, ctx ) :
  arguments.length === 3 ? new Side( code, ctx, p1 ) :
  arguments.length === 4 ? new Side( code, ctx, p1, p2 ) :
  arguments.length === 5 ? new Side( code, ctx, p1, p2, p3 ) :
  arguments.length === 6 ? new Side( code, ctx, p1, p2, p3, p4 ) :
                           new Side( code, ctx, p1, p2, p3, p4, p5 ) );
  
  // Enqueue code to run, each code is run as a side "action"
  var new_action = this;
  new_action.code = code;
  new_action.arguments = arguments;
  new_action.arguments[ 0 ] = new_action;
  Side._init(  new_action, ctx );
  Side._reset( new_action );
  
  // When provided a thenable, it provides the outcome.
  if( code.then ){
    new_action.promise = code;
  
  // When provided a callable, it is retried until no blocks.  
  }else{
    new_action.promise = new Promise( function( resolve, reject ){
      new_action.resolve = resolve;
      new_action.reject  = reject;
    } );
  }
  
  // Sub actions block their parent action
  if( new_action.parent !== RootAction ){
    new_action.parent.subactions++;
    // If parent action owns the mutex, so does the subaction
    if( new_action.parent.mutex === Mutex ){
      new_action.mutex = Mutex;
    }
  }
  
  Side._enqueue( new_action );

  return new_action;
  
}


Side._init = function( new_action, ctx ){
  
  // Assign unique id to action, useful to debug
  new_action.id = NextId++;
  
  // Make both Side.it and instance.it work
  new_action.it = new_action;
  
  // 1-trying, 2-writing, 3-erasing, 4-success, 5-failure
  new_action.state = 0;
  
  // When action is blocked, some deblocker function will unblock it
  new_action.deblocker = null;
  
  // Each action can have a different context or inherit the parent action one
  new_action.context = ctx || Side.context || {};
  
  // Initially, the outcome is "pending". Sentinel Side flags this situation
  new_action.outcome = { error: 0, value: Side };
  
  // All actions are thenables
  new_action.promise = null;
  
  // If side action is defined by a function, a promise resolver is needed
  new_action.resolve = null;
  new_action.reject  = null;
  
  // When a side action create an action, that subaction blocks the parent
  new_action.subactions = 0;
  
  // The current action, if any, is the parent of the new action
  new_action.parent = CurrentAction;
  
  // Unless this is the first "root" action...
  if( CurrentAction ){
    
    // Child action inherits the last cache key, as a snapshot
    new_action.init_last_key = CurrentAction.last_key;
  
    // Immediately abort new action if parent action is already done
    if( CurrentAction.state === 4 
    ||  CurrentAction.state === 5 
    ){
      // Unless current action the root action
      if( CurrentAction !== RootAction ){
        // ToDo: actual abort
      }
    }
  
  }else{
    new_action.init_last_key = "root";
  }
  
  // Action have "slots" that are equivalent to local variables
  new_action.next_slot_id = 0;
  
};


Side._reset = function( action ){
  
  // How many time the action was attempted
  action.attemps = 0;
  
  // Actions that have reversible side effects own the global mutex lock
  action.mutex = null;
  
  // Queue for delayed writes
  action.write_queue = [];
  
  // Queue to erase side effects
  action.restore_queue = [];
  
  // Queue for code to run once, after success or failure
  action.finally_queue = [];
  
  // Map to cache results made available for efficient retries
  action.local_cache = {};
  action.cached = {};
  
  // Slot table
  action.slots = [];
  
  // Usefull to check that slot allocation order is constant
  action.max_slot_id = 0;
  
  // The default key is the one set at action's creation
  action.last_key = action.init_last_key;

};


Side._process = function(){
// Process queued actions
  
  // If action processing loop is already active, it will do the work
  if( Side.active )return;
  
  // The action processing loop is active once only, ie never reentered
  Side.active = true;
  
  // While there are actions in the queue, run each action
  while( true ){
    
    // "write" actions must run before normal actions
    var queue = Writing ? WriteQueue : Queue;
    
    // Get next action
    var action = queue.shift();
    var idle_job;
    if( action ){
      action._process();
    }else{
      idle_job = IdleQueue.shift();
      if( idle_job ){
        idle_job();
      }
    }
    if( !action && !idle_job )break;
  }
  
  // Done with all queued actions, exit processing loop
  Side.active = false;
  
};


Side.prototype.toString = function(){
  return "Side." + this.id;
};


Side.prototype._process = function( error ){
// Private. Run one action.

  var action = this;

  // If there is a global mutex, make sure action can run now
  if( Mutex ){
    if( action.mutex !== Mutex ){
      console.log( "not mutex owner: " + action );
      return;
    }
  }
  
  // If sub actions are runnning, they must succeed first
  if( action.subactions )return;
  
  // Don't run if some deblocker function needs to be called first
  if( action.deblocker ){
    debugger;
    return;
  }
  
  // Remember new current action
  CurrentAction = action;
  Side.it = action;
  
  var is_promise = !action.resolve;
  
  // If first attempt ever
  if( action.state === 0 ){
    action.state = 1;
    if( is_promise ){
      action.attemps = 1;
      var queue = Writing ? WriteQueue : Queue;
      action.code.then(
        function( value ){
          action.outcome.value = value;
          action.state = 2;
          queue.push( action );
          Side._process();      
        },
        function( error ){
          action.outcome.error = error || true;
          action.outcome.value = error;
          action.state = 3;
          queue.push( action );
          Side._process();      
        }
      );
    }
  }
  
  // Until all blocks are cleared or error
  if( action.state === 1 && !is_promise ){
    
    this.write_queue   = [];
    this.restore_queue = [];
    this.finally_queue = [];
    this.last_key      = this.init_last_key;
    this.next_slot_id  = 0;
    
    this.attemps++;
    
    try{
      
      // Detect excessive attempts
      if( this.max_attempts && this.attemps > this.max_attempts 
      )throw new Error( "Side attempts" );
      
      var value = action.code.apply( action.context, action.arguments );
      
      // If no block, move forward with state, if needed
      if( action.state === 1 ){
        
        // Check action's progress
        if( action.next_slot_id > action.max_slot_id ){
          action.max_slot_id = action.next_slot_id;
        }else if( action.next_slot_id < action.max_slot_id ){
          throw new Error( "slot" );  
        }

        // Avoid self reference, may loop, ie don't promise itself
        if( value === action ){
          value = true;
        }
        
        action.state = 2;
        
        // Remember future result of action
        action.outcome.value = value;
        
      }
      
    }catch( error ){
      
      // If action is blocked, wait, else handle error
      if( error === Side ){
        
        // Remember what is the last side action that blocked
        Block = action;
        
        // Reverse side effects before waiting
        while( ( actions = action.restore_queue ).length ){
          action.restore_queue = [];
          process_writes( action, actions );
        }
        
      }else{
        
        // Move forward with state
        action.state = 3;
        
        // Remember future result of action
        action.outcome.error = error || true;
        
      }
      
    }
    
  }
  
  var actions;
  
  // If action is terminating after a success
  if( action.state === 2 && !action.subactions ){
    
    // Are there "write" operations to process?
    while( ( actions = action.write_queue ).length ){
      action.write_queue = [];
      if( action.parent !== RootAction ){
        // Postpone until parent action success
        var parent_write_queue = action.parent.write_queue;
        parent_write_queue.push.apply( parent_write_queue, actions );
      }else{
        process_writes( action, actions );
      }
    }
    
    // Are there restore actions to remember in case of parent action failure?
    if( action.parent !== RootAction ){
      actions = action.restore_queue;
      action.restore_queue = [];
      var parent_restore_queue = action.parent.restore_queue;
      parent_restore_queue.push.apply( parent_restore_queue, actions );
    }
    
    // If all done, deliver the success outcome
    if( !action.subactions ){
      action.state = 4;
      if( !is_promise ){
        action.resolve( action.outcome.value );
      }
    }
    
  }
  
  // If action is terminating after a failure  
  if( action.state === 3 ){
    
    // Are there actions to run to reverse side effects
    while( ( actions = action.restore_queue ).length ){
      action.restore_queue = [];
      process_writes( action, actions );
    }
    
    // If all done, deliver the failure outcome
    if( !action.subactions ){
      action.state = 5;
      if( !is_promise ){
        action.reject( action.outcome.error );
      }
    }
    
  }
  
  // Finally
  if( action.state === 4 || action.state === 5 ){
    
    // Are there actions to run finally
    while( ( actions = action.finally_queue ).length ){
      action.finally_queue = [];
      process_writes( action, actions );
    }
    
    // Unblock parent if last subaction
    if( !action.subactions ){
      signal_done( action );
    }
      
  }
  
  function signal_done( action ){
    // ToDo: +2 to state?
    // Free mutex lock
    if( Mutex === action ){
      Mutex = null;
    }
    if( action.mutex ){
      action.mutex = null;
    }
    // Unblock parent if last subaction
    if( action.parent !== RootAction ){
      action.parent.subactions--;
      // Retry parent action unless it is blocked
      if( !action.parent.subactions && !action.parent.deblocker ){
        Side._enqueue( action.parent );
      }
    }
  }
  
  function process_writes( action, actions ){
  // Run code when action was run successfully or failed
  
    if( !( actions && actions.length ) )return;
    
    actions.forEach( function( elem ){
      
      // Stay in exclusive "writing" mode until all is done
      Writing++;
      
      // Wait until all done or error
      Side( elem ).then(
        
        // If success, exit writing mode when all done
        function(){
          Writing--;
          Side._process();
        },
        
        // If failure, abort remaining actions and signal parent
        function( error ){
          Writing--;
          if( !action.parent.outcome.error ){
            action.parent.outcome.error = error || true;
            action.parent.state = 3;
          }
          Side._process();
        }
      );  
    } );
  }
  
  CurrentAction = RootAction;
  Side.it       = RootAction;

};


Side.prototype.is_block = function( err ){
// Checks whether an exception is actually a block that requires a retry.
// See side.wait() to raise such an exception, typically after a call to
// some kind of side.retry() or side.fill().
  return err === Side;
};


Side.prototype.catch = function( err ){
// Block detection, ie catch( err ){ side.catch( err ); ... err handling ... }
// When a function "blocks", it raises a special exception that is not to be
// handled like "normal" errors. side.catch() detects such blocks and rethrow
// the same special exception when it sees one.
  if( err === Side )throw err;
};


Side.prototype.start = Side;


Side.prototype.run = function(){
// Sugar for side.start( code ).get(). It blocks if the underlying code blocks.
  var action = this.start.apply( this, arguments );
  return action.get();
};


Side.prototype.retry = function( error ){
// Returns a function that will retry the current action.
// This function shall typically be used as a callback provided to
// an async function.
// A call to side.wait() is expected to follow soon.

  var action = this;
  
  if( action.outcome.error )throw action.outcome.error;

  // If action is a subaction, don't run it if parent is done
  if( action.parent !== RootAction ){
    var parent_state = action.parent.state;
    // If parent is done, abort child action
    if( parent_state === 4 
    ||  parent_state === 5
    )throw new Error( "Side done" );
  }
  
  // Return previous result if it is still available
  if( action.deblocker )return action.deblocker;
  
  var f = ( function( error ){
    
    if( Debug ){
      console.log( "Retry" );
    }
    
    // Do nothing if action is blocked on something else now
    if( this.deblocker !==  f )return;
    
    // Consume. Next call to side.retry() will hence return a new deblocker.
    this.deblocker = null;
    
    // Only running actions can be rerun, terminating ones can't
    if( this.state !== 1 )return;
    
    if( error ){
      this.outcome.error = error;
      this.state = 3;
    }
    
    // Retry the action unless f() is called immediately, ie sync.
    if( CurrentAction !== this ){
      Side._enqueue( this );
    }
    
  } ).bind( action );
  
  action.deblocker = f;
  
  return f;

};


Side._enqueue = function( code ){
  if( code.deblocker )debugger;
  var queue = Writing ? WriteQueue : Queue;
  queue.push( code );
  Side._process();
};


Side.prototype.wait = function( promise ){
// If needed, block the current action, ie generates an exception.
// If a thenable parameter is provided, the blocked action
// is automatically retried when the promise is fulfilled.
// Else, a previous call to Side.retry() must have provided
// the callback for the blocking async operation.

  var action = this;
  
  if( promise && promise.then ){
    var retry = action.retry();
    promise.then( 
      retry,
      function( error ){
        if( !action.outcome.error ){
          action.outcome.error = error || true;
        }
        retry( error );
      }
    );
  }else{
    // Don't block if retry() was not called recently
    if( !action.deblocker )return this;
  }
  
  throw Side;
};


Side.prototype.abort = function( error ){
  
  var action = this;
  
  if( action.state !== 0 ){
    Side._process();
  }
  
  // Is it too late to abort?
  if( action.state > 2 )return;
  
  action.state = 3;
  action.outcome.error = error || new Error( "Side abort" );
  Side._enqueue( action );
  
  if( action === CurrentAction )throw Side;
  
  return action;
  
};



Side.prototype.write = function( code, undo ){
// Queue action to write side effects when current action succeeds

  var action = this;

  // ToDo: handle "undo" in case of write error
  code.undo = undo;
  action.write_queue.push( code );
  
  return action;
  
};


Side.prototype.finally = function( code ){
// Registers code to run once when side action is done, both when it
// succeeds and when it fails.
  var action = this;
  action.finally_queue.push( code );
  return action;
};


Side.prototype.log = function(){
// Like console.log() but done when side action fully succeeds or fails.
// Direct usage of console.log() would instead reissue the same message
// multiple times due to multiple retries after blocks.
  var action = this;
  var args = arguments;
  action.finally( function(){
    console.log.apply( console, args );
  } );
  return action;
};


Side.prototype.error = function(){
// Like console.error() but done when side action fully succeeds or fails.
// Direct usage of console.error() would instead reissue the same message
// multiple times due to multiple retries after blocks.
  var action = this;
  var args = arguments;
  action.finally( function(){
    console.error.apply( console, args );
  } );
  return action;
};


// Like console.warn() but done when side action fully succeeds or fails.
// Direct usage of console.warn() would instead reissue the same message
// multiple times due to multiple retries after blocks.
Side.prototype.warn = function Warn(){
  var action = this;
  var args = arguments;
  action.finally( function(){
    console.warn.apply( console, args );
  } );
  return action;
};


Side.prototype.info = function(){
// Like console.info() but done when side action fully succeeds or fails.
// Direct usage of console.info() would instead reissue the same message
// multiple times due to multiple retries after blocks.
  var action = this;
  var args = arguments;
  action.finally( function(){
    console.info.apply( console, args );
  } );
  return action;
};


Side.prototype.restore = function( code, code2, no_mutex ){
// Queue action to erase side effects when current action fails or blocks.

  var action = this;
  
  if( code2 && !code2.call ){
    no_mutex = code2;
    code2 = null;
  }
  
  if( !no_mutex ){
    // Multiple restores must come from the same action or subactions of it
    if( !Mutex ){
      Mutex = action;
      action.mutex = action;
    }else{
      if( action.mutex !== Mutex )throw new Error( "Side mutex" );
    }
    if( code2 ){
      var safe = code();
      action.restore_queue.push( function(){ code2( safe ); } );
    }else{
      action.restore_queue.push( code );
    }
  }
  
  return action;
  
};


Side.prototype.effect = function( write, restore, flush ){
// Perform side effect and register action to either erase it
// or flush it depending on current side action's success or failure.
  var action = this;
  write();
  action.restore( restore );
  action.write( flush );
  return action;
};


Side.prototype.lambda = function( handler ){
// Make an AWS Lambda handler using simple code. 
// That code will receive 3 parameters. The initial event, the Side
// object and the context. When it runs the code can access the "context" 
// using the global variable Side.context.
  var lambda_handler = function( event, context, callback ){
    var side_action = Side( function(){
      try{
        callback( null, handler( event, Side, context ) );
      }catch( error ){
        Side.catch( error );
        callback( error );
      }
    }, context );
    return side_action;
  };
  return lambda_handler;
};


Side.prototype.ize = function( fn ){
// Helper to use side actions instead of function calls in order to minimize
// the amount of code to rerun when blocks and retries occur.
// Where calling a function that blocks 10 times means 10 retries of the
// current action, calling the Sideized version of the same function means that
// the current action will incur one retry only. The signature of the Sideized
// function is the same as the signature of the original function.
  var f = function(){
    var args = arguments;
    var that = this;
    return Side.it.run( function(){ return fn.apply( that, args ); } );
  };
  return f;
};


Side.prototype.idle = function Idle( code ){
// Registers code to run the next time all actions are blocked or done.
  IdleQueue.push( code );
  return this;
};


Side.prototype._cache_lookup = function CacheLookup( key ){
// Look for key in current side action's cache. If not found, look in
// parent caches to find a shared cache entry.
  
  var action = this;
  var cached = action.local_cache[ key ];
  
  if( cached )return cached;
  
  // Look for shared cache from parent action
  while( action = action.parent ){
    cached = action.local_cache[ key ];
    if( !cached )continue;
    return cached.shared ? cached : null;
  }
  
  return null;
  
};


Side.prototype.share = function( key, value, error ){
// To share a cached value with sub actions
  var action = this;
  key = action.key( key );
  var cached = action._cache_lookup( key );
  if( !cached ){
    action.set( key, value, error, action );
  }else{
    cached.shared = action;
  }
  return action;
};


Side.prototype.has = function( key ){
// Test presence in cache.
// Usage:
//  var r = Side.has( "r" ) ? Side.get() : Side.set( "r", compute() );
  var action = this;
  return !!action._cache_lookup( action.key( key ) );
};


Side.prototype.set = function( key, value, error, shared ){
  
  var action = this;
  
  key = action.key( key );
  
  var cached = action._cache_lookup( key );
  
  if( !cached || cached.shared !== action ){
    
    action.local_cache[ key ] = arguments.length > 1
    ? { error: error, value: value, shared: shared }
    : { error: error, value: true,  shared: shared };
    
    if( !error ){
      action.cached[ key ] = value;
    }else{
      delete action.cached[ key ];
    }
    
    return value;
  
  }
  
  cached.value = value;
  cached.error = error;
  
  if( !error ){
    action.cached[ key ] = value;
  }else{
    delete action.cached[ key ];
  }
  
  if( arguments.length > 3 ){
    cached.shared = shared;
  }
  
  return value;
  
};


Side.prototype.once = function( key, code ){
// Returns true or runs code if key is not in cache already.
// Returns false if key is in cache.
  var action = this;
  key = action.key( key );
  if( action.has( key ) )return code ? action.get( key ) : false;
  if( !code ){
    action.set( key );
  }else{
    action.set( key, code() );
  }
  return true;
};


Side.prototype.cache = function( key, code, error ){
// Get value from cache. Blocks until code to fill cache is run.

  var action = this;
  if( action.deblocker )throw Side;

  key = action.key( key );
  
  var cached = action._cache_lookup( key );
  
  // If cached value is available, use it
  if( cached ){
    // Use it as soon as the action to get it is done
    if( cached.value !== Side /* sentinel */ ){
      if( cached.error )throw cached.error;
      return cached.value;
    }
  
  // If cached value was never requested, queue action to get it  
  }else{

    cached 
    = action.local_cache[ key ] 
    = { error: null, value: Side, shared: false };
    
    // Only callables and thenable promises need that
    if( !code || ( !code.call && !code.then ) || error ){
      cached.value = code;
      cached.error = error;
      return action.cache( key );
    }
    
    var promise = code;

    // Promisify code if it is not a promise already
    if( !code.then ){
      promise = Side( function(){
        var result = code( Side.retry(), key );
        Side.wait();
        return result;
      } );
      // Optimize sync case
      if( cached.value !== Side )return Side.cache( key );
    }
    
    var retry = Side.retry();    
    
    promise.then(
      function( value ){
        cached.value = value;
        retry();
      },
      function( error ){
        cached.error = error || true;
        cached.value = null;
        retry();
      }
    );
  }
  
  // If pending action, it's a block
  throw Side;
  
};


Side.prototype.key = function( key /* , ... */ ){
// Build a new key to access cached values.
// Usage : k = Side.key( "x", y, z )
  var action = this;
  if( !arguments.length
  ||  ( arguments.length === 1  && typeof key === "undefined" )
  )return action.last_key;
  if( arguments.length === 1 && typeof key === "string" ){
    action.last_key = key;
    return key;
  }
  var new_key = JSON.stringify( [ "key_" ].concat( arguments ) );
  action.last_key = new_key; 
  return new_key;
};


Side.prototype.async_call = function( key, fun ){
  var action = this;
  key = action.key( key );
  var cb = action.fill( key );
  if( cb ){
    var args = Array.prototype.slice.call( arguments, 2 );
    args.push( cb );
    fun.apply( null, args );
    action.wait();
  }
  return action.cache( key );
};


Side.prototype.fill = function( key, as_array ){
// Tool to cache results of async calls based on callbacks.
// It returns a callback if the result is not in the cache already.
// If the result is already pending, it asks for a retry, ie
// it throws an exception.
// It returns null if the result is already available.
// as_array flag processes results without error detection, ie
// first argument of callback is not a node style error.
//
// Usage:
//   var result = side( "key", ()=> async_op( "key", side.fill() ) );
// Or:
//   side.fill( "key" ) && side.wait( async_op( "key", side.fill() ) ) 
//   var result = side.cache();
// Or:
//   var cb = side.fill( "key" ) );
//   cb && side.wait( async_op( "key", cb ) );
//   var result = Side.cache();
  
  var action = this;
  
  if( !arguments.length ){
    if( Filler ){
      var filler = Filler;
      Filler = null;
      return filler;
    }
    key = action.last_key;
  }else{
    key = action.key( key );
  }

  var cached = action._cache_lookup( key );
  
  if( cached ){
    if( cached.value !== Side )return null;
    throw Side;
  }
  
  cached = action.local_cache[ key ] 
  = { error: null, value: Side, shared: false };
  
  var retry = action.retry();
  
  var f = function( error ){
    if( Filler === f ){
      Filler = null;
    }
    if( action.deblocker !== f )return;
    action.deblocker = null;
    if( as_array ){
      cached.value = arguments.length <= 1 
      ? error 
      : Array.prototype.slice.call( arguments );
      action.cached[ key ] = cached.value;
    }else{
      if( error ){
        cached.error = error;
        delete action.cached[ key ];
      }else{
        if( arguments.length <= 2 ){
          cached.value = arguments[ 1 ];
        }else{
          cached.value = Array.prototype.slice.call( arguments, 1 );
        }
        action.cached[ key ] = cached.value;
      }
    }
    retry();
  };
  
  return Filler = f;

};


/*
 *  Slot class
 */

function SideSlot( action, id, undef ){
  this.action = action;
  this.id = id;
  this.last_key = action.last_key;
  this.value = undef;
  this.error = undef;
  action.slots[ id ] = this;
}


SideSlot.prototype.fill = function( value, error ){
// Fill a slot. Should be called after Side.needs( a_slot ) asked.
  this.error = error;
  return this.value = value;
};


SideSlot.prototype.filler = function(){
  var retry = Side.retry();
  var slot = this;
  var f = function( error, value ){
    if( error ){
      slot.error = error;
      slot.value = value;
    }else{
      if( arguments.length > 2 ){
        slot.value = Array.prototype.slice.call( arguments, 1 );
      }else{
        slot.value = value;
      }
    }
    retry();
  };
  return f;
};


SideSlot.prototype.get = function(){
  if( this.error )throw this.error;
  return this.value;
};


Side.prototype.slot = function( code ){
// Allocate a new slot or return the cached slot value.
// Throw an exception if slot desynchronisation is detected.
// See Side.needs() to check if a slot is new and needs to be filled.
  
  var action = this;
  
  var id = action.next_slot_id++;
  
  // If the slot already exists, provide the memorized outcome
  if( id < action.slots.length ){
    var slot = action.slots[ id ];
    // If not a new slot, check that it is not out of sync
    if( slot.last_key !== action.last_key
    )throw new Error( 
      "Side slot " + action.last_key + " vs " + slot.last_key
    );
    // Raise an exception if outcome was an error
    if( slot.error )throw slot.error;
    // Block if outcome is still pending
    if( slot.value === Side )throw Side;
    // Return the outcome value
    return slot.value;
  }
  
  // A new slot is needed, create it
  var new_slot = new SideSlot( action, id );
  
  if( code ){
    
    var filler;
    
    // A thenable promise
    if( code.then ){
      // Set sentinel value to flag pending outcome
      new_slot.value = Side;
      // Create a filler function to inject value (or error) in new slot
      filler = new_slot.filler();
      code.then( 
        function( ok ){ filler( ok ); },
        function( ko ){ filler( null, ko ); }
      );
      // Block
      Side.wait();
      
    // A callable function
    }else if( code.call ){
      new_slot.value = Side;
      filler = new_slot.filler();
      var result = code.call( null, filler );
      // Result may be a thenable promise
      if( result && result.then ){
        result.then( 
          function( ok ){ filler( null, ok ); },
          function( ko ){ filler( ko ); }
        );
        action.wait();
      // If not a promise, then the filler callback needs to be called
      }else{
        // Block unless filler was called
        if( new_slot.value === Side ){
          action.wait();
        }
      }
      
    // An immediate true value
    }else{
      new_slot.value = code;
    }
  
  // Some false value
  }else if( arguments.length ){
    new_slot.value = code;
  
  // Undefined slot, that needs to be filled later
  }else{
    new_slot.value = Side;
  }
  
  return new_slot;
  
};


Side.prototype.needs = function( slot ){
// Checks if a slot is new and needs to be filled.
// See also Side.slot() and a_slot.fill(). 
  if( !slot )return false;
  return slot.constructor === SideSlot;
};


Side.prototype.then = function( ok, ko ){
// Side actions are "thenable", ie promise compatible
  var action = this;
  Side._process();
  return action.promise.then( ok, ko );
};


Side.prototype.get = function( key ){
// Get outcome of a side action.
// This is the sync equivalent to a .then(). If the side
// action is not done yet, it blocks, ie it raises an
// exception that demands a retry of the current action.
  // When called with a parameter, it's actually sugar for .cache( key )
  if( arguments.length )return this.cache( key );
  // When .get() is called by current action, it's actually sugar for .cache()
  if( this === CurrentAction )return this.cache();
  // Optimist case when outcome is already available
  if( this.state === 4 )return this.outcome.value;
  if( this.state === 5 )throw  this.outcome.error;
  // Optimist case when outcome is easy (ie sync) to get now
  Side._process();
  if( this.state === 4 )return this.outcome.value;
  if( this.state === 5 )throw  this.outcome.error;
  // Pessimist case, need to block, waiting for outcome
  throw Side;
};



Side.prototype.restart = function( ctx ){
// An existing action can be restarted at any time. All cache
// entries are cleared. If a new context is provided, it overides
// the previous one. When called by the current action, that
// action is interrupted and restarted immediately.
  
  var action = this;
  
  var state = action.state;
  if( state !== 0 && state !== 4 && state !== 5 
  )throw new Error( "Side restart" );
  action.state = 0;
  
  if( arguments.length ){
    action.context = ctx;
  }
  
  Side._reset( action );
  
  Side._enqueue( action );
  
  if( action === CurrentAction )throw Side;
  
  return action;

};


Side.prototype.detach = function(){
// Detach a child action so that the parent action can terminate
// before the child action.

  var action = this;
  var parent = action.parent;

  // Do nothing if already detached
  if( parent === RootAction )return;
  
  // Set parent so that action is now a child of the root action
  action.parent = RootAction;
  
  // Action won't run until mutex owner action is done
  if( action.mutex && Mutex !== action ){
    action.mutex = null;
  }

  // Retry parent when no child action remains
  parent.subactions--;
  if( !parent.subactions && !parent.blocked() ){
    Side._enqueue( parent );
  }
  
  return action;
  
};


Side.prototype.blocked = function(){
  return !!this.deblocker;
};


Side.prototype.done = function(){
  return this.state === 4 || this.state === 5;
};


Side.prototype.success = function(){
  return this.state === 4;
};


Side.prototype.failure = function(){
  return this.state === 5 && this.outcome.error;
};


Side.prototype.smoke_tests = function( with_trace ){
  
  function log(){
    if( !with_trace )return true;
    console.log.apply( console, arguments );
  }
  
  function log_error(){
    if( !with_trace )return true;
    console.error.apply( console, arguments );
  }
  
  function delay( key ){
    if( Side.has( key ) )return;
    Side.set();
    setTimeout( Side.retry(), 300 );
    Side.wait();
  }
  
  console.log( "SMOKE TEST" );
  
  var test_id = 0;
  var errors = 0;
  
  Debug = with_trace;
  
  function ok( msg ){
    test_id++;
    log( "----- Test OK", msg, test_id );
    return true;
  }
  
  function ko( msg, error ){
    test_id++;
    log_error( "----- !Test Failure", msg, test_id );
    if( error ){
      log_error( "error:", error );
    }
    return false;
  }
  
  function is_ok( msg, ok ){ 
    log( msg );
    if( ok !== "ok" ){
      debugger;
      errors++;
      log_error( "expected ok but got", ok, "instead" );
      throw "not ok";
    }
    log( msg, "ok" ); 
    return true;
  }
  
  function blocks( msg, code ){
    log( "----- block: " + msg );
    try{
      code();
      log_error( "A block was expected but code ran without any" );
      throw "not ok block";
    }catch( err ){
      if( Side.it.is_block( err ) ){
        log( "block: " + msg, "ok" );
      }else{
        log_error( err );
        debugger;
        errors++;
        log_error( "A block was expected but an error occured instead", err );
        throw "not ok block";
      }
    }
    return Block;
  }
  
  // Test 1
  const Test1 = "Simple sync get";
  is_ok( Test1, Side( ()=> "ok" ).get() )
  && ok( Test1 );
  
  // Test 2
  const Test2 = "Simple then";
  Side( ()=> "ok" ).then( r => is_ok( Test2, r ) && ok( Test2 ) );
  
  // Test 3
  const Test3 = "Simple Promise get";
  var ok_side = Side( Promise.resolve( "ok" ) );
  var then
  = ok_side.then( r => is_ok( "promise", r )
    &&                 is_ok( "promise get", ok_side.get() )
    &&                 ok( Test3 ) );
  
  // Test 4
  const Test4 = "Simple async get";
  var retry;
  then = then.then( 
    ()=> blocks( Test4,
      ()=> Side( ( it )=> ( retry = it.retry() ) && it.wait() ).get()
    ) && setTimeout( ()=> retry(), 0 )
  ).then( ()=> ok( Test4 ) );
  
  // Test 5
  
  const Test5 = "Restore & write";
  var global_ok = "ok";
  var write_done = false;
  
  var x;
  then = then.then( 
    ()=> blocks( Test5, function(){
      x = Side( function( it ){
        it.log( Test5, "started" );
        is_ok( "global", global_ok );
        global_ok = "changed";
        it.restore( ()=> global_ok = "ok" );
        it.once( "t" ) && setTimeout( it.retry(), 0 );
        it.wait(); 
        is_ok( "retry", "ok" );
        is_ok( "local global change", global_ok === "changed" && "ok" );
        it.write( ()=> write_done = "ok" );
        it.log( Test5, "done" );
        return "ok";
      } );
      x.get();
    } )
  ).then( 
    function(){
      is_ok( "async get", x.get() );
      if( global_ok === "changed" ){
        is_ok( "global changed", global_ok = "ok" );
      }
      is_ok( "write done", write_done );
      ok( Test5 );
    },
    ( error )=> ko( Test5, error ) 
  );
  
  // Test 6
  
  var Test6 = "Mutex";

  var mutex = "ok";
  
  then = then.then(
    ()=> blocks( "mutex", ()=> Side( function( it ){
      it.restore( X=>X );
      mutex = "locked";
      it.once( "check mutex" )
      && setTimeout( ()=> Side( ()=> is_ok( "mutex", mutex ) ), 0 );
      it.once( "delay" )
      && setTimeout( it.retry(), 1000 );
      it.once( "check mutex 2" )
      && it.idle( ()=> is_ok( "locked", mutex === "locked" && "ok" ) );
      it.wait();
      if( it.once( "check mutex 3" ) ){
        Side( function( it ){
          is_ok( "locked for sub action", mutex === "locked" && "ok" );
          it.once( "delay" )
          && setTimeout( it.retry(), 500 );
          it.wait();
          is_ok( "kept locked", mutex === "locked" && "ok" );
        } );  
        it.once( "delay2" ) && setTimeout( it.retry(), 1000 );
        it.wait();
      }
      mutex = "ok";
      is_ok( "mutex free", mutex );
    } ).get() )
  ).then( ()=> ok( Test6 ), ( error )=> ko( Test6, error ) );
  
  // Test 7
  var Test7 = "share";
  then = then.then( ()=> Side( function( it ){
    it.share( "it" );
    it.set( "it", "ok" );
    is_ok( "parent", it.get() );
    Side( it => is_ok( "child", it.cache( "it" ) ) && ok( Test7 ) );
  } ), ( error )=> ko( Test7, error ) );
  
  
  // Test 8
  var Test8 = "slots";
  then = then.then( ()=> Side( function( it ){
    var a = it.slot();
    if( it.needs( a ) ){
      a = a.fill( "ok" );
    }
    is_ok( "slot", a ) && ok( Test8 );
  } ), ( error )=> ko( Test8, error ) );
  
  // Results
  
  var TESTS = 8;
  
  var test_result = new Promise( function( resolve, reject ){
    
    var done = false;
    
    function out(){
      if( done )return;
      done = true;
      Debug = false;
      if( !errors && test_id === TESTS ){
        log( "SUCCESS, all tests passed:", test_id );
        resolve( true );
      }else{
        log_error( "FAILURE, tests:", test_id, "errors:", errors );
        resolve( false );
      }
    }
    
    setTimeout( out, 50000 );
    then.then( out, out );
    
  } );
  
  return test_result;
  
};

// Create the root action and init global current action
RootAction = new Side( function(){ return "root"; } );
CurrentAction = RootAction;
Side.it = RootAction;

// Provide access to the root action
Side.prototype.root = RootAction;

// Alias, universal access to the action factory
Side.prototype.Side = Side;
Side.prototype.side = side;

// Export it
return Side;

} ) );
