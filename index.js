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


// To help debug, De&&bug() and De&&mand()
var De = false;

function bug(){
  console.log.apply( console.log, arguments );
}

function mand( ok, msg ){
  if( ok )return;
  console.warn( "Failed assert:", msg );
}
 
// Side actions are child actions of some parent, the root action when none
var RootAction;

// When running, an action becomes the "current" action
var CurrentAction;

// Unique id for actions, useful to debug, available thru side_action.id
var NextId = 0;
 
// Pending write actions will block normal ones, non write actions are delayed
var Writing = false;

// When using .restore(), a Side action (and subactions) own a global mutex
var Mutex = null;

// When mutex is owned, other actions are queued, they run when mutex is free
var MutexQueue = [];

// Queue of actions to process
var Queue = [];

// Alternative queue when in "writing" mode
var WriteQueue = [];

// Queue of functions to call next time other queues are empty
var IdleQueue = [];

// Easy access to last action that blocked via some kind of "throw Side;"
var Block = null;


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

  // Syntax sugar, Side(), with no parameters, is Side.it.slot();
  if( !arguments.length )return Side.it.slot();

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
  
  // 1-trying, 2-writing, 3-erasing, 4-success, 5-failure
  new_action.state = 0;
  
  // Assign unique id to action, useful to debug
  new_action.id = NextId++;
  
  // Make both Side.it and instance.it work
  new_action.it = new_action;
  
  // When action is blocked, some deblocker function will unblock it
  new_action.deblocker = null;
  
  // Each action can have a different context or inherit the parent action one
  new_action.context = ctx || Side.context || {};
  
  // Initially, the outcome is "pending". Sentinel Side flags this situation
  new_action._outcome = { error: 0, value: Side };
  
  // All actions are thenables
  new_action.promise = null;
  
  // If side action is defined by a function, a promise resolver is needed
  new_action.resolve = null;
  new_action.reject  = null;
  
  // When a side action create an action, that subaction blocks the parent
  new_action.subactions = 0;
  
  // Actions that have reversible side effects own the global mutex lock
  new_action.mutex = null;
    
  // The current action, if any, is the parent of the new action
  new_action.parent = CurrentAction;
  
  // Unless this is the first "root" action...
  if( CurrentAction ){
    
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
  
  // How many time the action was attempted
  new_action.attempts = 0;
  
  // Queue for delayed writes
  new_action.write_queue = null;
  
  // Queue to erase side effects
  new_action.restore_queue = null;
  
  // Queue for code to run once, after success or failure
  new_action.finally_queue = null;
  
  // Slot table
  new_action.slots = [];
  
  // Action have "slots" that are equivalent to local variables
  new_action.next_slot_id = 0;
  
  // Usefull to check that slot allocation order is constant
  new_action.max_slot_id = 0;
  
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
  
  new_action._enqueue();

  return new_action;
  
}


Side._process = function(){
// Process queued actions
  
  // If action processing loop is already active, it will do the work
  if( Side.active )return;
  
  // The action processing loop is active once only, ie never reentered
  Side.active = true;
  
  // While there are actions in the queue, run each action
  while( true ){
    
    // "write" actions must run before normal actions
    var queue;
    if( !Mutex && MutexQueue.length ){
      queue = MutexQueue;
    }else{
      if( Writing ){
        queue = WriteQueue;
      }else{
        queue = Queue;
      }
    }
    
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

  // If there is a global mutex, make sure candidate action can run now
  if( Mutex ){
    // Or else, remember to run it when mutex is free
    if( action.mutex !== Mutex ){
      MutexQueue.push( this );
      return;
    }
  }
  
  // If sub actions are runnning, they must succeed first
  if( action.subactions )return;
  
  // Don't run if some deblocker function needs to be called first
  if( action.deblocker && action.deblocker !== Side ){
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
      var queue = Writing ? WriteQueue : Queue;
      action.code.then(
        function( value ){
          action._outcome.value = value;
          action.state = 2;
          queue.push( action );
          Side._process();      
        },
        function( error ){
          action._outcome.error = error || true;
          action._outcome.value = error;
          action.state = 3;
          queue.push( action );
          Side._process();      
        }
      );
    }
  }
  
  if( action.state === 1 ){
    this.attemps++;
    this.write_queue   = [];
    this.restore_queue = [];
    this.finally_queue = [];
    this.last_key      = this.init_last_key;
    this.next_slot_id  = 0;
  }
  
  // Until all blocks are cleared or error
  if( action.state === 1 && !is_promise ){
  
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
          throw new Error( "Side slot" );  
        }

        // Avoid self reference, may loop, ie don't promise itself
        if( value === action ){
          value = true;
        }
        
        action.state = 2;
        
        // Remember future result of action
        action._outcome.value = value;
        
      }
      
    }catch( error ){
      
      // If action is blocked, wait, else handle error
      if( error === Side ){
        
        // Remember what is the last side action that blocked
        Block = action;
        
        // Reverse side effects before waiting
        process_writes( action, action.restore_queue );
        
      }else{
        
        // Move forward with state
        action.state = 3;
        
        // Remember future result of action
        action._outcome.error = error || true;
        
      }
      
    }
    
  }
  
  var actions;
  
  // If action is terminating after a success
  if( action.state === 2 && !action.subactions ){
    
    // Are there "write" operations to process?
    if( ( actions = action.write_queue ).length ){
      if( action.parent !== RootAction ){
        // Postpone until parent action success
        var parent_write_queue = action.parent.write_queue;
        parent_write_queue.push.apply( parent_write_queue, actions );
        action.write_queue = [];
      }else{
        process_writes( action, actions );
      }
    }
    
    // Are there restore actions to remember in case of parent action failure?
    if( action.parent !== RootAction && action.restore_queue.length ){
      actions = action.restore_queue;
      action.restore_queue = [];
      var parent_restore_queue = action.parent.restore_queue;
      parent_restore_queue.push.apply( parent_restore_queue, actions );
    }
    
    // If all done, deliver the success outcome
    if( !action.subactions ){
      action.state = 4;
      if( !is_promise ){
        action.resolve( action._outcome.value );
      }
    }
    
  }
  
  // If action is terminating after a failure  
  if( action.state === 3 ){
    
    // Are there actions to run to reverse side effects
    process_writes( action, action.restore_queue );
    
    // If all done, deliver the failure outcome
    if( !action.subactions ){
      action.state = 5;
      if( !is_promise ){
        action.reject( action._outcome.error );
      }
    }
    
  }
  
  // Finally
  if( action.state === 4 || action.state === 5 ){
    
    // Are there actions to run finally?
    action.state -= 2;
    process_writes( action, action.finally_queue );
    action.state += 2;
    
    // Unblock parent if last subaction
    if( !action.subactions ){
      signal_done( action );
    }
      
  }
  
  function signal_done( action ){
    // ToDo: +2 to state?
    // Free mutex lock
    if( action.mutex ){
      action.mutex = null;
      if( Mutex === action ){
        Mutex = null;
      }
    }
    // Unblock parent if last subaction
    var parent = action.parent;
    if( parent !== RootAction ){
      parent.subactions--;
      // Retry parent action unless it is otherwise blocked
      if( !parent.subactions && !parent.deblocker ){
        action.parent._enqueue();
      }
    }
  }
  
  function process_writes( action, actions ){
  // Run code when action was run successfully or failed
  
    if( !( actions && actions.length ) ){
      if( Writing ){
        Writing = false;
      }
      return false;
    }
    
    var next = actions.shift();
    
    Writing = true;
    
    action.start( next ).end().then(
      function(){ process_writes( action, actions ); },
      function( error ){
        if( !action.parent._outcome.error ){
          action.parent._outcome.error = error || true;
          action.parent.state = 3;
        }
        if( Writing ){
          Writing = false;
        }
        Side._process();
      }
    );
    
    return true;
    
  }
  
  CurrentAction = RootAction;
  Side.it = RootAction;
  
  return this;

};


Side.prototype.is_block = function( err ){
// Checks whether an exception is actually a block that requires a retry.
// See side.wait() to raise such an exception, typically after a call to
// some kind of side.retry().
  return err === Side;
};


Side.prototype.catch = function( err ){
// Block detection, ie catch( err ){ side.catch( err ); ... err handling ... }
// When a function "blocks", it raises a special exception that is not to be
// handled like "normal" errors. side.catch() detects such blocks and rethrow
// the same special exception when it sees one.
  if( err === Side )throw err;
};


Side.prototype.start = function(){
  if( this !== CurrentAction )throw new Error( "Side current" );
  return Side.apply( null, arguments );
};


Side.prototype.run = function(){
// Sugar for side.start( code ).outcome(). It blocks if the underlying code blocks.
  var action = this.start.apply( this, arguments );
  return action._outcome();
};


Side.prototype.end = function( result ){
// Prepare for last block
   this._check_can_block();
   this._outcome.value = result;
   this.deblocker =  null;
   return this;
   this.retry( Side );
   return this;
};


Side.prototype._check_can_block = function(){
  
  if( this._outcome.error ){
    throw this._outcome.error;
  }
  
  if( this.state > 3 ){
    throw new Error( "Side state" );
  }

  // If action is a subaction, don't run it if parent is done
  if( this.parent !== RootAction ){
    var parent_state = this.parent.state;
    // If parent is done, abort child action
    if( parent_state === 4 
    ||  parent_state === 5
    )throw new Error( "Side parent done" );
  }
  
  return this;
  
};


Side.prototype.retry = function( cb ){
// Returns a function that will retry the current action.
// This function shall typically be used as a callback provided to
// an async function.
// A call to side.wait() is expected to follow soon.

  this._check_can_block();
  
  // Return previous result if it is still available
  if( this.deblocker )return this.deblocker;
  
  var f = ( function( error ){
    
    De&&bug( "Retry" );
    
    // Do nothing if action is blocked on something else now
    if( this.deblocker !==  f )return;
    
    // Consume. Next call to side.retry() will hence return a new deblocker.
    this.deblocker = null;
    
    // Only running actions can be rerun, terminating ones can't
    if( this.state !== 1 )return;
    
    if( cb && cb !== Side ){
      cb.apply( null, arguments );
    
    }else if( error ){
      this._outcome.error = error;
      this.state = 3;
    
    }else if( cb === Side ){
      this.state = 2;
    }
    
    // Retry the action unless f() is called immediately, ie sync.
    if( CurrentAction !== this ){
      this._enqueue();
    }
    
  } ).bind( this );
  
  this.deblocker = f;
  
  return f;

};


Side.prototype._enqueue = function(){
  if( this.deblocker )debugger;
  var queue = Writing ? WriteQueue : Queue;
  queue.push( this );
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
        if( !action._outcome.error ){
          action._outcome.error = error || true;
        }
        retry( error );
      }
    );
  }else{
    // Don't block if retry() was not called recently
    if( !action.deblocker )return promise;
  }
  
  throw Side;
};


Side.prototype.abort = function( error ){

  if( this.state !== 0 ){
    Side._process();
  }
  
  // Is it too late to abort?
  if( this.state > 2 )return this;
  
  this.state = 3;
  this._outcome.error = error || new Error( "Side abort" );
  this._enqueue();
  
  if( this === CurrentAction )throw Side;
  
  return this;
  
};



Side.prototype.write = function( code, undo ){
// Queue action to write side effects when current action succeeds

  // ToDo: handle "undo" in case of write error
  code.undo = undo;
  this.write_queue.push( code );
  
  return this;
  
};


Side.prototype.finally = function( code ){
// Registers code to run once when side action is done, both when it
// succeeds and when it fails.
  this.finally_queue.push( code );
  return this;
};


Side.prototype.log = function(){
// Like console.log() but done when side action fully succeeds or fails.
// Direct usage of console.log() would instead reissue the same message
// multiple times due to multiple retries after blocks.
  var args = arguments;
  this.finally( function(){
    console.log.apply( console, args );
  } );
  return this;
};


Side.prototype.error = function(){
// Like console.error() but done when side action fully succeeds or fails.
// Direct usage of console.error() would instead reissue the same message
// multiple times due to multiple retries after blocks.
  var args = arguments;
  this.finally( function(){
    console.error.apply( console, args );
  } );
  return this;
};


// Like console.warn() but done when side action fully succeeds or fails.
// Direct usage of console.warn() would instead reissue the same message
// multiple times due to multiple retries after blocks.
Side.prototype.warn = function Warn(){
  var args = arguments;
  this.finally( function(){
    console.warn.apply( console, args );
  } );
  return this;
};


Side.prototype.info = function(){
// Like console.info() but done when side action fully succeeds or fails.
// Direct usage of console.info() would instead reissue the same message
// multiple times due to multiple retries after blocks.
  var args = arguments;
  this.finally( function(){
    console.info.apply( console, args );
  } );
  return this;
};


Side.prototype.restore = function( code, save, no_mutex ){
// Queue action to erase side effects when current action fails or blocks.

  if( !no_mutex ){
    // Multiple restores must come from the same action or subactions of it
    if( !Mutex ){
      Mutex = this;
      this.mutex = this;
    }else{
      if( this.mutex !== Mutex )throw new Error( "Side mutex" );
    }
  }
  
  if( arguments.length > 1 ){
    this.restore_queue.push( function(){ code.call( null, save ); } );
  }else{
    this.restore_queue.push( code );
  }
  
  return this;
  
};


Side.prototype.lambda = function( handler ){
// Make an AWS Lambda handler using simple code. 
// That code will receive 3 parameters. The initial event, the Side
// object and the context. When it runs the code can access the "context" 
// using the global variable Side.context.
  var lambda_handler = function( event, context, callback ){
    var side_action = Side( function( side, context ){
      try{
        callback( null, handler( event, side, context ) );
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
  if( fn.side === Side )return fn;
  var f = function(){
    var args = arguments;
    var that = this;
    return Side.it.run( function(){ return fn.apply( that, args ); } );
  };
  // Flag to avoid duplicate sideized
  f.side = Side;
  return f;
};


Side.prototype.idle = function Idle( code ){
// Registers code to run the next time all actions are blocked or done.
  IdleQueue.push( code );
  return this;
};


/*
 *  Slot class
 */

function SideSlot( id, undef ){
  this.value = undef;
  this.error = undef;
}


SideSlot.prototype._filler = function( action ){
  var retry = action.retry();
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


Side.prototype.slot = function( code ){
// Allocate a new slot or return the cached slot value.
// Throw an exception if slot desynchronisation is detected.
// See Side.needs() to check if a slot is new and needs to be filled.
  
  var action = this;
  
  var id = action.next_slot_id++;

  // If the slot already exists, provide the memorized outcome
  if( id < action.slots.length ){
    var slot = action.slots[ id ];
    // Raise an exception if outcome was an error
    if( slot.error )throw slot.error;
    // Block if outcome is still pending
    if( slot.value === Side )throw Side;
    // Return the outcome value
    return slot.value;
  }
  
  // A new slot is needed, create it
  var new_slot = new SideSlot( action, id );
  
  action.slots[ id ] = new_slot;
  
  if( code ){
    
    var filler;
    
    // A thenable promise
    if( code.then ){
      // Set sentinel value to flag pending outcome
      new_slot.value = Side;
      // Create a filler function to inject value (or error) in new slot
      filler = new_slot._filler( action );
      code.then( 
        function( ok ){ filler( null, ok ); },
        function( ko ){ filler( ko ); }
      );
      // Block
      Side.wait();
      
    // A callable function
    }else if( code.call ){
      new_slot.value = Side;
      filler = new_slot._filler( action );
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
  
  }else{
    
    new_slot.value = code;
    
  }
  
  return new_slot.value;
  
};


Side.prototype.then = function( ok, ko ){
// Side actions are "thenable", ie promise compatible
  Side._process();
  return this.promise.then( ok, ko );
};


Side.prototype.outcome = function(){
// Get outcome of a side action.
// This is the sync equivalent to a .then(). If the side
// action is not done yet, it blocks, ie it raises an
// exception that demands a retry of the current action.
  // Optimist case when outcome is already available
  if( this.state === 4 )return this._outcome.value;
  if( this.state === 5 )throw  this._outcome.error;
  // Optimist case when outcome is easy (ie sync) to get now
  Side._process();
  if( this.state === 4 )return this._outcome.value;
  if( this.state === 5 )throw  this._outcome.error;
  // Pessimist case, need to block, waiting for outcome
  throw Side;
};


Side.prototype.detach = function(){
// Detach a child action so that the parent action can terminate
// before the child action.

  var action = this;
  var parent = this.parent;

  // Do nothing if already detached
  if( parent === RootAction )return;
  
  // Set parent so that action is now a child of the root action
  this.parent = RootAction;
  
  // Action won't run until mutex owner action is done
  if( this.mutex && Mutex !== this ){
    this.mutex = null;
  }

  // Retry parent when no child action remains
  parent.subactions--;
  if( !parent.subactions && !parent.blocked() ){
    parent._enqueue();
  }
  
  return action;
  
};


Side.prototype.once = function( key ){
  if( this.context[ key ] )return false;
  this.context[ key ] = true;
  return true;
};


Side.prototype.blocked = function(){
  return !!this.deblocker;
};


Side.prototype.pending = function(){
  return this.state === 1;
};


Side.prototype.done = function(){
  return this.state === 4 || this.state === 5;
};


Side.prototype.success = function(){
  return this.state === 4;
};


Side.prototype.failure = function(){
  return this.state === 5 && this._outcome.error;
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
  
  // Activate traces and assert when in debug mode
  De = with_trace;
  
  function ok( msg ){
    test_id++;
    log( "----- Test OK", msg, test_id, "\n" );
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
  is_ok( 
    Test1, 
    Side( function(){ 
      return "ok"; 
    } ).outcome()
  );
  ok( Test1 );
  
  // Test 2
  const Test2 = "Simple then";
  Side( function(){
    return "ok";
  } ).then( function( r ){
    is_ok( Test2, r );
    ok( Test2 );
  } );
  
  // Test 3
  const Test3 = "Simple Promise get";
  var ok_side = Side( Promise.resolve( "ok" ) );
  var then = ok_side.then( function( r ){
    is_ok( "promise", r );
    is_ok( "promise get", ok_side.outcome() );
    ok( Test3 );
  } );
  
  // Test 4
  const Test4 = "Simple async get";
  var retry;
  then = then.then( 
    function(){
      blocks( 
        Test4,
        function( it ){ 
          Side( function( it ){ 
            retry = it.retry();
            it.wait();
          } ).outcome();
        }
      );
      setTimeout( function(){
        retry();
      }, 0 );
    }
  ).then( function(){ ok( Test4 ); } );
  
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
      x.outcome();
    } )
  ).then( 
    function(){
      is_ok( "async get", x.outcome() );
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
    } ).outcome() )
  ).then( ()=> ok( Test6 ), ( error )=> ko( Test6, error ) );
  
  // Test 7
  var Test7 = "slots";
  then = then.then( ()=> Side( function( it ){
    var a = it.slot( function( cb ){
      cb( null, "ok" );
    } );
    is_ok( "slot", a ) && ok( Test7 );
  } ), ( error )=> ko( Test7, error ) );
  
  // Results
  
  var TESTS = 7;
  
  var test_result = new Promise( function( resolve, reject ){
    
    var done = false;
    
    function out(){
      if( done )return;
      done = true;
      De = false;
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

// Alias, universal access to the side action factory
Side.prototype.Side = Side;
Side.prototype.side = Side;

// Export it
return Side;

} ) );
