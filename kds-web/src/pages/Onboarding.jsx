import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../supabase';
import { 
  Building2, Clock, UtensilsCrossed, CheckCircle2, 
  ChevronRight, ChevronLeft, Plus, Trash2, Rocket 
} from 'lucide-react';

export default function Onboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  
  // Step 1 State
  const [restaurant, setRestaurant] = useState({
    name: '',
    whatsapp_phone_number_id: '',
    whatsapp_token: '',
    timezone: 'Asia/Kolkata',
    support_phone: '',
    owner_email: '',
    owner_password: ''
  });

  // Step 2 State
  const [ops, setOps] = useState({
    opening_time: '09:00',
    closing_time: '23:00',
    valid_table_numbers: '1,2,3,4,5,6,7,8,9,10',
    tax_rate: 0.05,
    amendment_window_mins: 5
  });

  // Step 3 State
  const [menuItems, setMenuItems] = useState([]);
  const [newItem, setNewItem] = useState({ item_code: '', name: '', price: '', category: '', available: true });

  const handleNext = () => setStep(s => Math.min(4, s + 1));
  const handlePrev = () => setStep(s => Math.max(1, s - 1));

  const addMenuItem = () => {
    if (menuItems.length >= 50) {
      setError("Maximum 50 items allowed during onboarding.");
      return;
    }
    if (!newItem.item_code || !newItem.name || !newItem.price) {
      setError("Please fill out item code, name, and price.");
      return;
    }
    setMenuItems([...menuItems, { ...newItem, price: parseFloat(newItem.price) }]);
    setNewItem({ item_code: '', name: '', price: '', category: '', available: true });
    setError('');
  };

  const removeMenuItem = (index) => {
    setMenuItems(menuItems.filter((_, i) => i !== index));
  };

  const launchRestaurant = async () => {
    setIsSubmitting(true);
    setError('');
    
    try {
      // 1. Create Restaurant
      const { data: restData, error: restError } = await supabase
        .from('restaurants')
        .insert({
          name: restaurant.name,
          whatsapp_phone_number_id: restaurant.whatsapp_phone_number_id,
          whatsapp_token: restaurant.whatsapp_token,
          timezone: restaurant.timezone,
          support_phone: restaurant.support_phone,
          opening_time: ops.opening_time,
          closing_time: ops.closing_time,
          valid_table_numbers: ops.valid_table_numbers.split(',').map(s => s.trim()),
          tax_rate: ops.tax_rate,
          amendment_window_mins: ops.amendment_window_mins,
          subscription_status: 'trial'
        })
        .select()
        .single();
        
      if (restError) throw restError;
      const restaurant_id = restData.id;

      // 2. Insert Menu Items
      if (menuItems.length > 0) {
        const enrichedItems = menuItems.map(item => ({
          ...item,
          restaurant_id
        }));
        const { error: menuError } = await supabase.from('menu_items').insert(enrichedItems);
        if (menuError) throw menuError;
      }

      // 3. Create Auth User
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: restaurant.owner_email,
        password: restaurant.owner_password
      });

      if (authError) throw authError;

      if (authData.user) {
        // Create Staff Record explicitly
        const { error: staffError } = await supabase.from('staff').insert({
          id: authData.user.id,
          display_name: 'Owner',
          role: 'owner',
          restaurant_id: restaurant_id
        });
        if (staffError) throw staffError;
      }

      // 4. Success State
      setStep(5);
    } catch (err) {
      console.error(err);
      setError(err.message || "Failed to launch restaurant.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-2xl">
        <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
          Restaurant Setup
        </h2>
        
        {/* Progress Bar */}
        {step < 5 && (
          <div className="mt-8 mb-4">
            <div className="flex items-center justify-between">
              {[
                { label: 'Details', icon: Building2 },
                { label: 'Operations', icon: Clock },
                { label: 'Menu', icon: UtensilsCrossed },
                { label: 'Review', icon: CheckCircle2 }
              ].map((s, i) => (
                <div key={i} className="flex flex-col items-center">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center ${step > i ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-400'}`}>
                    <s.icon className="w-5 h-5" />
                  </div>
                  <span className="text-xs mt-2 text-gray-500 font-medium">{s.label}</span>
                </div>
              ))}
            </div>
            <div className="relative mt-2">
              <div className="absolute top-0 h-1 bg-gray-200 w-full rounded"></div>
              <div className="absolute top-0 h-1 bg-indigo-600 rounded transition-all" style={{ width: `${((step - 1) / 3) * 100}%` }}></div>
            </div>
          </div>
        )}

        {error && (
          <div className="mb-4 bg-red-50 border-l-4 border-red-400 p-4">
            <p className="text-red-700">{error}</p>
          </div>
        )}

        <div className="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10 mt-6">
          
          {/* STEP 1 */}
          {step === 1 && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium">Business Details</h3>
              <div>
                <label className="block text-sm font-medium text-gray-700">Restaurant Name</label>
                <input type="text" className="mt-1 p-2 block w-full border border-gray-300 rounded-md" value={restaurant.name} onChange={e => setRestaurant({...restaurant, name: e.target.value})} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">WhatsApp Phone ID</label>
                  <input type="text" className="mt-1 p-2 block w-full border border-gray-300 rounded-md" value={restaurant.whatsapp_phone_number_id} onChange={e => setRestaurant({...restaurant, whatsapp_phone_number_id: e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">WhatsApp Token</label>
                  <input type="password" className="mt-1 p-2 block w-full border border-gray-300 rounded-md" value={restaurant.whatsapp_token} onChange={e => setRestaurant({...restaurant, whatsapp_token: e.target.value})} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Support Phone</label>
                  <input type="text" className="mt-1 p-2 block w-full border border-gray-300 rounded-md" value={restaurant.support_phone} onChange={e => setRestaurant({...restaurant, support_phone: e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Timezone</label>
                  <select className="mt-1 p-2 block w-full border border-gray-300 rounded-md" value={restaurant.timezone} onChange={e => setRestaurant({...restaurant, timezone: e.target.value})}>
                    <option value="Asia/Kolkata">Asia/Kolkata</option>
                    <option value="UTC">UTC</option>
                  </select>
                </div>
              </div>
              <h3 className="text-lg font-medium mt-6 pt-4 border-t">Owner Login credentials</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Account Email</label>
                  <input type="email" className="mt-1 p-2 block w-full border border-gray-300 rounded-md" value={restaurant.owner_email} onChange={e => setRestaurant({...restaurant, owner_email: e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Account Password</label>
                  <input type="password" className="mt-1 p-2 block w-full border border-gray-300 rounded-md" value={restaurant.owner_password} onChange={e => setRestaurant({...restaurant, owner_password: e.target.value})} />
                </div>
              </div>
            </div>
          )}

          {/* STEP 2 */}
          {step === 2 && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium">Operations Configuration</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Opening Time</label>
                  <input type="time" className="mt-1 p-2 block w-full border border-gray-300 rounded-md" value={ops.opening_time} onChange={e => setOps({...ops, opening_time: e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Closing Time</label>
                  <input type="time" className="mt-1 p-2 block w-full border border-gray-300 rounded-md" value={ops.closing_time} onChange={e => setOps({...ops, closing_time: e.target.value})} />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Valid Table Numbers (comma separated)</label>
                <input type="text" className="mt-1 p-2 block w-full border border-gray-300 rounded-md" value={ops.valid_table_numbers} onChange={e => setOps({...ops, valid_table_numbers: e.target.value})} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Tax Rate (Decimal)</label>
                  <input type="number" step="0.01" className="mt-1 p-2 block w-full border border-gray-300 rounded-md" value={ops.tax_rate} onChange={e => setOps({...ops, tax_rate: e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Amendment Window (mins)</label>
                  <input type="number" className="mt-1 p-2 block w-full border border-gray-300 rounded-md" value={ops.amendment_window_mins} onChange={e => setOps({...ops, amendment_window_mins: e.target.value})} />
                </div>
              </div>
            </div>
          )}

          {/* STEP 3 */}
          {step === 3 && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium">Initial Menu Setup</h3>
              <p className="text-sm text-gray-500">You can add more items later in the Manager portal. (Up to 50 items now)</p>
              
              <div className="flex gap-2 items-start mt-4 bg-gray-50 p-4 rounded-md">
                <input type="text" placeholder="Code (e.g. P1)" className="p-2 border rounded-md w-24" value={newItem.item_code} onChange={e => setNewItem({...newItem, item_code: e.target.value})} />
                <input type="text" placeholder="Name" className="p-2 border rounded-md flex-1" value={newItem.name} onChange={e => setNewItem({...newItem, name: e.target.value})} />
                <input type="number" placeholder="Price" className="p-2 border rounded-md w-24" value={newItem.price} onChange={e => setNewItem({...newItem, price: e.target.value})} />
                <button type="button" onClick={addMenuItem} className="p-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"><Plus className="w-5 h-5"/></button>
              </div>

              <div className="mt-4 max-h-60 overflow-y-auto">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead>
                    <tr>
                      <th className="px-3 py-2 text-left">Code</th>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-left">Price</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {menuItems.map((item, i) => (
                      <tr key={i} className="border-t border-gray-100">
                        <td className="px-3 py-2">{item.item_code}</td>
                        <td className="px-3 py-2">{item.name}</td>
                        <td className="px-3 py-2">₹{item.price}</td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => removeMenuItem(i)} className="text-red-600 hover:text-red-900"><Trash2 className="w-4 h-4"/></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* STEP 4 */}
          {step === 4 && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium">Review & Launch</h3>
              <div className="bg-gray-50 p-4 rounded text-sm space-y-2">
                <p><strong>Restaurant:</strong> {restaurant.name}</p>
                <p><strong>Admin Email:</strong> {restaurant.owner_email}</p>
                <p><strong>Meta Phone ID:</strong> {restaurant.whatsapp_phone_number_id}</p>
                <p><strong>Hours:</strong> {ops.opening_time} to {ops.closing_time}</p>
                <p><strong>Initial Menu Items:</strong> {menuItems.length}</p>
              </div>
            </div>
          )}

          {/* STEP 5 (SUCCESS) */}
          {step === 5 && (
            <div className="text-center py-8">
              <Rocket className="w-16 h-16 text-indigo-600 mx-auto mb-4" />
              <h3 className="text-xl font-bold text-gray-900">Restaurant Successfully Bridged!</h3>
              <p className="mt-4 text-gray-600 text-sm max-w-sm mx-auto">
                Please set up your WhatsApp webhook in the Meta interface securely properly natively.
              </p>
              <div className="mt-8">
                <button onClick={() => navigate('/')} className="bg-indigo-600 text-white px-6 py-2 rounded shadow hover:bg-indigo-700">
                  Proceed to Login
                </button>
              </div>
            </div>
          )}

          {/* Navigation */}
          {step < 5 && (
            <div className="mt-8 pt-4 border-t flex justify-between">
              {step > 1 ? (
                <button type="button" onClick={handlePrev} className="flex items-center text-gray-600 hover:text-gray-900 px-4 py-2 border rounded-md">
                  <ChevronLeft className="w-4 h-4 mr-1" /> Back
                </button>
              ) : <div></div>}

              {step < 4 ? (
                <button type="button" onClick={handleNext} className="flex items-center bg-indigo-600 text-white px-6 py-2 rounded-md hover:bg-indigo-700">
                  Next <ChevronRight className="w-4 h-4 ml-1" />
                </button>
              ) : (
                <button type="button" onClick={launchRestaurant} disabled={isSubmitting} className="flex items-center bg-green-600 text-white px-6 py-2 rounded-md hover:bg-green-700 shadow disabled:bg-gray-400">
                  {isSubmitting ? 'Launching...' : 'Launch Restaurant'} <Rocket className="w-4 h-4 ml-2" />
                </button>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
