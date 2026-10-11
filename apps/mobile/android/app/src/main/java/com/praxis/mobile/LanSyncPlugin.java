package com.praxis.mobile;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import java.io.*;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.*;
@CapacitorPlugin(name="LanSync") public class LanSyncPlugin extends Plugin {
  private final java.util.concurrent.ExecutorService executor=java.util.concurrent.Executors.newSingleThreadExecutor();
  private SecretKey key() throws Exception {
    KeyStore ks=KeyStore.getInstance("AndroidKeyStore");
    ks.load(null);
    if(!ks.containsAlias("praxis-lan")){
      KeyGenerator gen=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
      gen.init(new KeyGenParameterSpec.Builder("praxis-lan",KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
      gen.generateKey();
    }
    return (SecretKey)ks.getKey("praxis-lan",null);
  }
  private synchronized JSONObject config() throws Exception {
    SharedPreferences prefs=getContext().getSharedPreferences("lan-secure",Context.MODE_PRIVATE);
    File provision=new File(getContext().getFilesDir(),"lan-provision.json");
    if((getContext().getApplicationInfo().flags&ApplicationInfo.FLAG_DEBUGGABLE)!=0&&provision.exists()){
      String source;
      try (FileInputStream in=new FileInputStream(provision);
      ByteArrayOutputStream out=new ByteArrayOutputStream()){
        byte[] bytes=new byte[8192];
        int n;
        while((n=in.read(bytes))!=-1){
          if(out.size()+n>65536)throw new Exception("Pairing too large");
          out.write(bytes,0,n);
        }
        source=out.toString(StandardCharsets.UTF_8.name());
      }
      JSONObject c=new JSONObject(source);
      URL u=new URL(c.getString("baseUrl"));
      if(!u.getProtocol().equals("https")||u.getUserInfo()!=null||!u.getPath().isEmpty()||u.getQuery()!=null||u.getRef()!=null)throw new Exception("Invalid endpoint");
      for(String field:new String[]{
        "ownerId","deviceId","token","caPem"
      }
      )if(c.getString(field).isEmpty())throw new Exception("Missing pairing field");
      Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE,key());
      String encoded=Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(cipher.doFinal(source.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
      if(!prefs.edit().putString("config",encoded).commit())throw new Exception("Pairing storage failed");
      if(!provision.delete())throw new Exception("Pairing cleanup failed");
    }
    String encoded=prefs.getString("config",null);
    if(encoded==null)return null;
    String[] parts=encoded.split(":");
    Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));
    return new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),StandardCharsets.UTF_8));
  }
  @PluginMethod public void status(PluginCall call){
    executor.execute(()->{
      try{
        JSONObject c=config();
        JSObject result=new JSObject();
        result.put("configured",c!=null);
        if(c!=null)for(String f:new String[]{
          "baseUrl","ownerId","deviceId"
        }
        )result.put(f,c.getString(f));
        call.resolve(result);
      }
      catch(Exception e){
        call.reject("无法读取安全配对配置");
      }
    }
    );
  }
  @PluginMethod public void request(PluginCall call){
    executor.execute(()->{
      HttpsURLConnection connection=null;
      try{
        JSONObject c=config();
        if(c==null)throw new Exception("Unpaired");
        String method=call.getString("method"),path=call.getString("path");
        if(!(("POST".equals(method)&&"/v1/captures/commands".equals(path))||("GET".equals(method)&&path!=null&&path.matches("/v1/captures/changes\\?after=[0-9]+&limit=25"))))throw new Exception("Forbidden endpoint");
        KeyStore trust=KeyStore.getInstance(KeyStore.getDefaultType());
        trust.load(null);
        trust.setCertificateEntry("lan",CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(c.getString("caPem").getBytes(StandardCharsets.UTF_8))));
        TrustManagerFactory factory=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        factory.init(trust);
        SSLContext ssl=SSLContext.getInstance("TLS");
        ssl.init(null,factory.getTrustManagers(),null);
        connection=(HttpsURLConnection)new URL(c.getString("baseUrl")+path).openConnection();
        connection.setSSLSocketFactory(ssl.getSocketFactory());
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(8000);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Authorization","Bearer "+c.getString("token"));
        if("POST".equals(method)){
          connection.setDoOutput(true);
          connection.setRequestProperty("Content-Type","application/json");
          JSONObject body=new JSONObject(call.getObject("body").toString());
          if(!c.getString("deviceId").equals(body.getString("deviceId")))throw new Exception("Device mismatch");
          byte[] payload=body.toString().getBytes(StandardCharsets.UTF_8);
          if(payload.length>1048576)throw new Exception("Body too large");
          try(OutputStream out=connection.getOutputStream()){
            out.write(payload);
          }
        }
        int status=connection.getResponseCode();
        InputStream stream=status<400?connection.getInputStream():connection.getErrorStream();
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        if(stream!=null)try(InputStream in=stream){
          byte[] buffer=new byte[8192];
          int n;
          while((n=in.read(buffer))!=-1){
            if(bytes.size()+n>16777216)throw new Exception("Response too large");
            bytes.write(buffer,0,n);
          }
        }
        JSObject result=new JSObject();
        result.put("status",status);
        result.put("body",new JSObject(bytes.toString(StandardCharsets.UTF_8.name())));
        call.resolve(result);
      }
      catch(Exception e){
        call.reject("局域网连接失败，请检查网络、服务器和证书");
      }
      finally{
        if(connection!=null)connection.disconnect();
      }
    }
    );
  }
}
