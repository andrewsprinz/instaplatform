var url = require('url'),
    settings = require('./settings'),
    helpers = require('./helpers/helpers'),
    crypto = require('crypto'),
    redis = require('redis'),
    subscriptions = require('./subscriptions'),
    app = settings.app,
    geo = require('geo');

// Handshake to verify any new subscription requests.

app.get('/callbacks', function(request, response){
  helpers.instagram.subscriptions.handshake(request, response); 
});

// Receive authentication callbacks from Instagram

app.get('/callbacks/oauth', function(request, response){
  helpers.instagram.oauth.ask_for_access_token({
    request: request,
    response: response,
    redirect: '/callbacks/confirmed',
    complete: function(params){
      // Add this user to our local cache.
      // As this happens asyncronously, and instagram-node-lib has already
      // sent an empty 200 header, the homepage may not display this user
      // on first load, so we'll head over to a fake confirmation page instead
      var r = redis.createClient(settings.REDIS_PORT,settings.REDIS_HOST);
      r.hexists('authenticated_users', params['user'].username,function(error,code) {
        if(code=="0") {
          // Bit messy, but we need to access users by username and id
          // throughout the app, must be a better way to do this...
          r.hset('authenticated_users', params['user'].username, JSON.stringify(params));
          r.hset('authenticated_users_ids', params['user'].id, JSON.stringify(params));
        }
        r.quit();
      });
    }
  });
});

// Annoying, but required for now, will attempt to fork
// Instagram-node-lib to get around this

app.get('/callbacks/confirmed',function(request,response){
  response.render('confirmation');
})

// The POST callback for Instagram to call every time there's an update
// to one of our subscriptions.

app.post('/callbacks', function(request, response){

  // Verify the payload's integrity by making sure it's coming from a trusted source.
  var hmac = crypto.createHmac('sha1', settings.CLIENT_SECRET);
  hmac.update(request.rawBody);
  var providedSignature = request.headers['x-hub-signature'];
  var calculatedSignature = hmac.digest(encoding='hex');
  if((providedSignature != calculatedSignature) || !request.body) response.send('FAIL');
      
  // Go through and process each update. Note that every update doesn't
  // include the updated data - we use the data in the update to query
  // the Instagram API to get the data we want.
  var updates = request.body;  
  
  for(index in updates) {
    
    // Instagram seems to issue the update notification before the
    // media is actually available to the non-realtime API, so
    // we have a timeout before sending updates to the users
    
    var update = updates[index];
  	
    if(update['object'] == "tag") setTimeout(function(){ helpers.tags.processUpdate(update['object_id']); } ,2000);
    if(update['object'] == "geography") setTimeout(function(){ helpers.geographies.processUpdate(update['object_id']); } ,2000);
    if(update['object'] == "location") setTimeout(function(){ helpers.locations.processUpdate(update['object_id']); } ,2000);
    if(update['object'] == "user") setTimeout(function(){ helpers.users.processUpdate(update['object_id']); } ,2000);
        
  }
  
});

// Render user http requests

app.get('/', function(request, response) {
  
  // URL to allow users to authenticate and add themselves to the app
  authorization_url = helpers.instagram.oauth.authorization_url({});
  channel = 'home'
  
  // Pull a list of authenticated users from our local cache 
  // then render the homepage
  var r = redis.createClient(settings.REDIS_PORT,settings.REDIS_HOST);
  user_hash = r.hgetall('authenticated_users', function(error, user_hash){
    response.render('home', {locals: {authenticated_users:user_hash}});
  });
  r.quit();

});

// This follows the same format as socket requests
// but assumes :method to be 'subscribe'

app.get('/channel/:channel/:value', function(request, response){
  
  channel = request.params.channel;
  value = request.params.value;
  
  if(channel=='tags') {
    
    // Ensure we're subscribed to this tag then
    // load the latest photos from the static API
    helpers.tags.validateTagSubscription(value);
    helpers.instagram.tags.recent({ 
      name: value, 
      complete: function(data,pagination) {
        helpers.setMinID('channel:'+channel+':'+value, data, pagination.min_tag_id);
      	response.render('channels/tags', { locals: { media: data, tag: value } });
      },
      error: function(errorMessage, errorObject, caller) {
        console.log(errorMessage);
        response.render('channels/tags', { locals: { media: new Array(), tag: value } });
      }
    });
    
  } else if(channel=='users') {
    
    username = request.params.value
    
    // Display a list of this user's recent media, real-time updates will 
    // be handled by the generic subscription handler as these subscriptions
    // are not user specific
    var r = redis.createClient(settings.REDIS_PORT,settings.REDIS_HOST);
    r.hget('authenticated_users', username,function(error,user){
      user_data = JSON.parse(user);
      helpers.instagram.users.recent({ 
        user_id: user_data.user.id, 
        access_token: user_data.access_token,
        complete: function(data,pagination) {
        	response.render('channels/users', { locals: { media: data, user: user_data.user } });
        },
        error: function(errorMessage, errorObject, caller) {
          console.log(errorMessage);
          response.render('channels/users', { locals: { media: new Array(), user: user_data.user } });        
        }
      });
    });
    r.quit();
          
  } else if(channel=='locations') {
    
    location = request.params.value
    
    // Ensure we're subscribed to this location then
    // load the latest photos from the static API
    helpers.locations.validateSubscription(location);
    
    var r = redis.createClient(settings.REDIS_PORT,settings.REDIS_HOST);
    r.hget('locations', location, function(error,location_data){
      loc_data = JSON.parse(location_data);
      helpers.instagram.locations.recent({ 
        location_id: location, 
        complete: function(data,pagination) {
          helpers.setMinID('channel:'+channel+':'+location, data, false);
        	response.render('channels/locations', { locals: { media: data, location: loc_data } });
        },
        error: function(errorMessage, errorObject, caller) {
          console.log(errorMessage);
          response.render('channels/locations', { locals: { media: new Array(), location: loc_data } });
        }
      });
    });
 
  } else if(channel=='geographies') {
    
    // This should be an instagram location id
    geography = request.params.value
    
    // Grab recent photos for this geography
    var r = redis.createClient(settings.REDIS_PORT,settings.REDIS_HOST);
    r.hget('geographies', geography, function(error, geography){
      geography_data = JSON.parse(geography)
      helpers.instagram.geographies.recent({ 
        geography_id: geography_data.object_id,
        complete: function(data,pagination) {
          helpers.setMinID('channel:'+channel+':'+geography_data.object_id, data, false);
        	response.render('channels/geographies', { locals: { media: data, geography: geography_data } });
        },
        error: function(errorMessage, errorObject, caller) {
          response.render('channels/geographies', { locals: { media: new Array(), geography: geography_data } });
        }
      });
    });
    r.quit();

  } else {
    
    // Unrecognised channel
    response.render('error', { 
      locals: { error: 'Pardon?' } 
    });

  }
  
});

// Location based requests are a little more complicated
// and generally need lat-lngs or search terms translated
// into either instagram 'locations' (based on 4sq) or 
// instagram 'geographies' (arbitrary areas) defined by lat-lng

app.post('/channel/:channel/', function(request,response) {
  
  channel = request.params.channel;
  
  if(channel=="geographies") {

    if(request.body.address) {
      geo.geocoder(geo.google, request.body.address, false, function(formattedAddress, lat, lng) {
         helpers.instagram.geographies.subscribe({ 
            lat: lat,
            lng: lng,
            radius: request.body.radius,
            complete: function(data) {
              data.geography_name = request.body.address;
              data.latitude = lat;
              data.longitude = lng;
              var r = redis.createClient(settings.REDIS_PORT,settings.REDIS_HOST);
              r.hset('geographies', data.object_id, JSON.stringify(data),function(error,result){
                response.redirect('/channel/geographies/'+data.object_id)
              });
              r.quit();
            }
          });
      });
    } else if (request.body.lat && request.body.lng) {
      helpers.instagram.geographies.subscribe({ 
        lat:request.body.lat,
        lng: request.body.lng,
        radius: request.body.radius,
        complete: function(data) {
          data.latitude = request.body.lat;
          data.longitude = request.body.lng;
          data.geography_name = 'nearby';
          var r = redis.createClient(settings.REDIS_PORT,settings.REDIS_HOST);
          r.hset('geographies', data.object_id, JSON.stringify(data),function(error,result){
            response.redirect('/channel/geographies/'+data.object_id)
          });
          r.quit();
        }
      });
    } else {
        response.render('error', { 
          locals: { error: 'Pardon?' } 
        });
    }
    
  } else {
    response.render('error', { 
      locals: { error: 'Pardon?' } 
    });
  }
  
});

/* 
  
  Demo/homepage utilities
  
*/

// Clear all subscriptions from redis and Instagram

app.get('/subscriptions/delete', function(request, response) {
  helpers.instagram.subscriptions.unsubscribe_all('all');
  var r = redis.createClient(settings.REDIS_PORT,settings.REDIS_HOST);
  r.flushdb();
  r.quit();
  response.render('confirmation');
});

// Remove a user from our authenticated list

app.get('/user/delete/:username', function(request,response){
  var r = redis.createClient(settings.REDIS_PORT,settings.REDIS_HOST);
  r.hdel('authenticated_users', request.params.username);
  r.quit();
  response.render('confirmation');
});

app.listen(settings.appPort);