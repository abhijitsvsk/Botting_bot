const url = process.env.SUPABASE_URL + '/rest/v1/user_sessions?phone=eq.918921027691';
fetch(url, {
  method: 'DELETE',
  headers: {
    'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
  }
}).then(async r => console.log(r.status, await r.text()));
